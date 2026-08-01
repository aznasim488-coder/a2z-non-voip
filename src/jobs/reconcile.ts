/**
 * Reconciliation sweep — three jobs:
 *
 * A) CRASH RECOVERY (every 90 s)
 *    Heals orders stuck between debitWallet and updateOrderSuccess.
 *
 * B) EXPIRED-WITHOUT-OTP REFUND (every 5 min)
 *    STR RESERVED > 25 min old → refund.
 *    LTR RESERVED past end_time AND is_renewed=false → refund.
 *    LTR RESERVED past end_time AND is_renewed=true  → EXPIRED, no refund.
 *
 * C) STR REUSE EXPIRY REFUND (every 2 min)
 *    STR reuse window is 10 min. If no new SMS arrives within 10 min of a
 *    reuse debit, refund the $0.80 charge automatically.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PvaDealsClient } from '../upstream/client.js';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot/middleware.js';
import type { Env } from '../config/env.js';
import { getPendingOrders, updateOrderSuccess, updateOrderFailed } from '../domain/orders.js';
import { creditWallet } from '../domain/wallet.js';
import { formatCents } from '../domain/money.js';

const SWEEP_MS         = 90_000;       // crash-recovery interval
const STALE_MS         = 90_000;       // stale order threshold
const EXPIRE_SWEEP_MS  = 5 * 60_000;  // B: initial purchase expiry sweep
const REUSE_SWEEP_MS   = 2 * 60_000;  // C: reuse expiry sweep (faster — 10-min window)
const STR_EXPIRE_MIN   = 25;          // refund STR initial purchase after 25 min
const REUSE_EXPIRE_MIN = 10;          // STR reuse window is 10 min

export class ReconcileSweep {
  private timer: ReturnType<typeof setInterval> | null = null;
  private expireTimer: ReturnType<typeof setInterval> | null = null;
  private reuseTimer: ReturnType<typeof setInterval> | null = null;

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
    setTimeout(() => void this.expiredRefundSweep(), 10_000);
    this.expireTimer = setInterval(() => void this.expiredRefundSweep(), EXPIRE_SWEEP_MS);
    if (this.expireTimer.unref) this.expireTimer.unref();

    // C) STR reuse expiry refund (every 2 min — fast response to 10-min window)
    setTimeout(() => void this.refundExpiredReuseStr(), 30_000);
    this.reuseTimer = setInterval(() => void this.refundExpiredReuseStr(), REUSE_SWEEP_MS);
    if (this.reuseTimer.unref) this.reuseTimer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.expireTimer) { clearInterval(this.expireTimer); this.expireTimer = null; }
    if (this.reuseTimer) { clearInterval(this.reuseTimer); this.reuseTimer = null; }
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

    // STR orders have plan = 'STR'. Filter by status RESERVED + old enough
    const { data: expiredStrs } = await this.db
      .from('orders')
      .select('id,user_id,sell_cents,number,service_name')
      .eq('status', 'RESERVED')
      .eq('plan', 'STR')
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

    // LTR orders have plan IN ('LTR3','LTR7','LTR14','LTR30')
    // We filter by end_time < now() to catch expired ones
    const { data: expiredLtrs } = await this.db
      .from('orders')
      .select('id,user_id,sell_cents,number,service_name,is_renewed')
      .eq('status', 'RESERVED')
      .in('plan', ['LTR3', 'LTR7', 'LTR14', 'LTR30'])
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

  // ── C: STR reuse expiry refund ──────────────────────────────────────────────

  /**
   * Find STR reuse debits older than 10 min with no new SMS after them.
   * Strategy:
   *   1. Query ledger_entries WHERE kind='reuse' AND created_at between 10min–24h ago
   *      (24h cap avoids scanning the whole table forever)
   *   2. For each, check sms_messages for any entry on same order AFTER the reuse time
   *   3. If no SMS found → refund; idempotency key prevents double-refund
   */
  private async refundExpiredReuseStr(): Promise<void> {
    try {
      const cutoffOld = new Date(Date.now() - REUSE_EXPIRE_MIN * 60_000).toISOString();
      const cutoffNew = new Date(Date.now() - 24 * 60 * 60_000).toISOString(); // max 24h back

      const { data: reuseEntries } = await this.db
        .from('ledger_entries')
        .select('id,user_id,amount_cents,idempotency_key,order_id,created_at')
        .eq('kind', 'reuse')
        .lt('created_at', cutoffOld)   // older than 10 min
        .gt('created_at', cutoffNew);  // but not older than 24 h

      if (!reuseEntries || reuseEntries.length === 0) return;

      for (const entry of reuseEntries as {
        id: string;
        user_id: string;
        amount_cents: number;
        idempotency_key: string;
        order_id: string | null;
        created_at: string;
      }[]) {
        if (!entry.order_id) continue;

        const refundKey = `${entry.idempotency_key}_reuse_expire_refund`;

        // Skip if already refunded (idempotency check)
        const { data: existing } = await this.db
          .from('ledger_entries')
          .select('id')
          .eq('idempotency_key', refundKey)
          .maybeSingle();
        if (existing) continue;

        // Check if a new SMS arrived AFTER this reuse request
        const { data: sms } = await this.db
          .from('sms_messages')
          .select('id')
          .eq('order_id', entry.order_id)
          .gt('received_at', entry.created_at)
          .limit(1)
          .maybeSingle();

        if (sms) continue; // OTP arrived — no refund needed

        // No OTP in 10 min → refund the reuse charge
        const reuseCents = Math.abs(entry.amount_cents);
        try {
          await creditWallet(this.db, {
            userId: entry.user_id,
            amountCents: reuseCents,
            kind: 'refund',
            idempotencyKey: refundKey,
            note: 'Auto-refund: STR reuse expired (no OTP in 10 min)',
          });

          await this.dmUser(
            entry.user_id,
            `🔄 <b>Reuse Refund</b>\n` +
            `No OTP arrived within 10 minutes of your reuse request.\n` +
            `<b>${formatCents(reuseCents)}</b> has been refunded to your wallet.`,
          );

          console.log(`[reconcile] STR reuse expire refund ${entry.id} — ${formatCents(reuseCents)}`);
        } catch (e) {
          console.error(`[reconcile] STR reuse refund error ${entry.id}:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.error('[reconcile] reuse-expire sweep error:', e instanceof Error ? e.message : e);
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
