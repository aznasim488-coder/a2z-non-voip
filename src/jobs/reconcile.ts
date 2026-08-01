/**
 * Reconciliation sweep — two jobs in one:
 *
 * A) CRASH RECOVERY (every 90 s)
 *    Heals orders that got stuck between debitWallet and updateOrderSuccess
 *    (server crash window). Tries to match upstream request; auto-refunds if
 *    not found.
 *
 * B) EXPIRED-WITHOUT-OTP REFUND (every 5 min)
 *    When a RESERVED number expires without ever getting an OTP:
 *      • STR: expires ~20 min after purchase → refund after 25 min
 *      • LTR: expires at end_time → refund if is_renewed = false
 *    If is_renewed = true (user manually renewed) → NO refund, just mark EXPIRED.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PvaDealsClient } from '../upstream/client.js';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot/middleware.js';
import type { Env } from '../config/env.js';
import { getPendingOrders, updateOrderSuccess, updateOrderFailed } from '../domain/orders.js';
import { creditWallet } from '../domain/wallet.js';
import { formatCents } from '../domain/money.js';

const SWEEP_MS        = 90_000;   // crash-recovery sweep interval
const STALE_MS        = 90_000;   // age before order is "stale" for crash recovery
const EXPIRE_SWEEP_MS = 5 * 60_000; // expired-without-OTP sweep interval
const STR_EXPIRE_MIN  = 25;       // STR expires ~20 min; we refund after 25 min

export class ReconcileSweep {
  private timer: ReturnType<typeof setInterval> | null = null;
  private expireTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: SupabaseClient,
    private readonly pva: PvaDealsClient,
    private readonly bot?: Bot<BotContext>,
    private readonly env?: Env,
  ) {}

  start(): void {
    // A) Crash-recovery sweep
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    if (this.timer.unref) this.timer.unref();

    // B) Expired-without-OTP refund sweep (run immediately + every 5 min)
    setTimeout(() => void this.expiredRefundSweep(), 10_000); // initial delay 10s
    this.expireTimer = setInterval(() => void this.expiredRefundSweep(), EXPIRE_SWEEP_MS);
    if (this.expireTimer.unref) this.expireTimer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.expireTimer) { clearInterval(this.expireTimer); this.expireTimer = null; }
  }

  // ── A: Crash recovery ──────────────────────────────────────────────────────

  private async sweep(): Promise<void> {
    try {
      const pending = await getPendingOrders(this.db, STALE_MS);
      if (pending.length === 0) return;

      console.log(`[reconcile] checking ${pending.length} stale orders`);

      for (const order of pending) {
        try {
          const { requests } = await this.pva.listRequests({ first: 50 });
          const match = requests.find(
            (r) =>
              r.serviceId === order.service_id &&
              Math.abs(new Date(r.endTime).getTime() - new Date(order.created_at).getTime()) < 300_000,
          );

          if (match) {
            await updateOrderSuccess(this.db, order.id, {
              requestId: match._id,
              number: match.number,
              status: 'RESERVED',
              endTime: match.endTime,
            });
            console.log(`[reconcile] healed order ${order.id} → ${match._id}`);
          } else {
            await updateOrderFailed(this.db, order.id, 'reconcile: upstream request not found');
            await creditWallet(this.db, {
              userId: order.user_id,
              amountCents: order.sell_cents,
              kind: 'refund',
              idempotencyKey: order.idempotency_key + '_reconcile_refund',
              note: 'Auto-refund: reconciliation',
            });
            console.log(`[reconcile] refunded order ${order.id}`);
          }
        } catch (e) {
          console.error(`[reconcile] error on order ${order.id}:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.error('[reconcile] sweep error:', e instanceof Error ? e.message : e);
    }
  }

  // ── B: Expired-without-OTP refund ─────────────────────────────────────────

  private async expiredRefundSweep(): Promise<void> {
    try {
      await this.refundExpiredStr();
      await this.refundExpiredLtr();
    } catch (e) {
      console.error('[reconcile] expired-refund sweep error:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * STR orders in RESERVED status older than 25 minutes → refund + EXPIRED.
   * STR has no end_time; we use created_at + 25 min as the expiry window.
   */
  private async refundExpiredStr(): Promise<void> {
    const cutoff = new Date(Date.now() - STR_EXPIRE_MIN * 60_000).toISOString();

    const { data: expiredStrs } = await this.db
      .from('orders')
      .select('id,user_id,sell_cents,number,service_name')
      .eq('status', 'RESERVED')
      .eq('type', 'STR')
      .lt('created_at', cutoff);

    if (!expiredStrs || expiredStrs.length === 0) return;

    console.log(`[reconcile] ${expiredStrs.length} expired STR(s) to refund`);

    for (const order of expiredStrs as {
      id: string; user_id: string; sell_cents: number; number: string; service_name: string;
    }[]) {
      try {
        // Mark EXPIRED
        await this.db
          .from('orders')
          .update({ status: 'EXPIRED' } as any)
          .eq('id', order.id);

        // Refund wallet
        await creditWallet(this.db, {
          userId: order.user_id,
          amountCents: order.sell_cents,
          kind: 'refund',
          idempotencyKey: `str_expire_refund_${order.id}`,
          note: 'Auto-refund: STR expired without OTP',
        });

        // Notify user
        await this.dmUser(order.user_id,
          `🔄 <b>Auto-Refund</b>\n` +
          `Your STR number (<code>${order.number ?? 'N/A'}</code>) expired without receiving an OTP.\n` +
          `<b>${formatCents(order.sell_cents)}</b> has been refunded to your wallet automatically.`,
        );

        console.log(`[reconcile] STR expire refund ${order.id} — ${formatCents(order.sell_cents)}`);
      } catch (e) {
        console.error(`[reconcile] STR expire refund error ${order.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  /**
   * LTR orders in RESERVED status past end_time:
   *   • is_renewed = false → refund + EXPIRED (never got OTP)
   *   • is_renewed = true  → just EXPIRED, no refund (user knowingly renewed)
   */
  private async refundExpiredLtr(): Promise<void> {
    const now = new Date().toISOString();

    const { data: expiredLtrs } = await this.db
      .from('orders')
      .select('id,user_id,sell_cents,number,service_name,is_renewed')
      .eq('status', 'RESERVED')
      .eq('type', 'LTR')
      .lt('end_time', now);

    if (!expiredLtrs || expiredLtrs.length === 0) return;

    console.log(`[reconcile] ${expiredLtrs.length} expired LTR(s) to process`);

    for (const order of expiredLtrs as {
      id: string; user_id: string; sell_cents: number; number: string;
      service_name: string; is_renewed: boolean;
    }[]) {
      try {
        // Mark EXPIRED
        await this.db
          .from('orders')
          .update({ status: 'EXPIRED' } as any)
          .eq('id', order.id);

        if (order.is_renewed) {
          // User renewed → no refund (non-refundable renewal policy)
          await this.dmUser(order.user_id,
            `⏰ <b>LTR Number Expired</b>\n` +
            `Your number (<code>${order.number ?? 'N/A'}</code>) has expired.\n` +
            `<i>No refund — this number was renewed.</i>`,
          );
          console.log(`[reconcile] LTR expired (renewed, no refund) ${order.id}`);
        } else {
          // Never renewed and never got OTP → full refund
          await creditWallet(this.db, {
            userId: order.user_id,
            amountCents: order.sell_cents,
            kind: 'refund',
            idempotencyKey: `ltr_expire_refund_${order.id}`,
            note: 'Auto-refund: LTR expired without OTP',
          });

          await this.dmUser(order.user_id,
            `🔄 <b>Auto-Refund</b>\n` +
            `Your LTR number (<code>${order.number ?? 'N/A'}</code>) expired without receiving an OTP.\n` +
            `<b>${formatCents(order.sell_cents)}</b> has been refunded to your wallet automatically.`,
          );

          console.log(`[reconcile] LTR expire refund ${order.id} — ${formatCents(order.sell_cents)}`);
        }
      } catch (e) {
        console.error(`[reconcile] LTR expire error ${order.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  /** Send a DM to a user by their user_id (profile.id). */
  private async dmUser(userId: string, html: string): Promise<void> {
    if (!this.bot) return;
    try {
      const { data: profile } = await this.db
        .from('profiles')
        .select('telegram_id')
        .eq('id', userId)
        .single();
      if (!profile) return;
      await this.bot.api.sendMessage(
        (profile as { telegram_id: number }).telegram_id,
        html,
        { parse_mode: 'HTML' },
      ).catch(() => undefined);
    } catch { /* ignore */ }
  }
}
