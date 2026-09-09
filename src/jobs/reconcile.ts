/**
 * Reconciliation sweep — four jobs:
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
 *
 * D) SMS POLL FALLBACK (every 30 s)
 *    Polls upstream for RESERVED orders to detect OTPs that arrived but
 *    whose webhook was missed (e.g. app restart during all 5 retries).
 *    When detected, updates order to COMPLETED and notifies the user.
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
const OTP_POLL_MS      = 30_000;      // D: SMS poll fallback (30 s)
const OTP_POLL_MIN_AGE = 60_000;      // Don't poll orders younger than 1 min (give webhook time)
const STR_EXPIRE_MIN   = 21;          // PVADeals STR window = 20 min; refund after 21 min
const REUSE_EXPIRE_MIN = 22;          // STR reuse window = 22 min; refund after 22 min

export class ReconcileSweep {
  private timer: ReturnType<typeof setInterval> | null = null;
  private expireTimer: ReturnType<typeof setInterval> | null = null;
  private reuseTimer: ReturnType<typeof setInterval> | null = null;
  private smsPollTimer: ReturnType<typeof setInterval> | null = null;

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

    // D) SMS poll fallback — catch missed webhooks (every 30 s)
    setTimeout(() => void this.pollForMissedOtp(), 15_000);
    this.smsPollTimer = setInterval(() => void this.pollForMissedOtp(), OTP_POLL_MS);
    if (this.smsPollTimer.unref) this.smsPollTimer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.expireTimer) { clearInterval(this.expireTimer); this.expireTimer = null; }
    if (this.reuseTimer) { clearInterval(this.reuseTimer); this.reuseTimer = null; }
    if (this.smsPollTimer) { clearInterval(this.smsPollTimer); this.smsPollTimer = null; }
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
      .eq('reuse_count', 0)
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

        // Check if a new SMS arrived WITHIN this specific reuse's 10-min window.
        // IMPORTANT: bound the upper time to created_at + 10 min so that OTPs
        // from a *later* reuse request don't block refund of this earlier one.
        const reuseExpiry = new Date(
          new Date(entry.created_at).getTime() + REUSE_EXPIRE_MIN * 60_000,
        ).toISOString();

        const { data: sms } = await this.db
          .from('sms_messages')
          .select('id')
          .eq('order_id', entry.order_id)
          .gt('received_at', entry.created_at)   // after this reuse request
          .lt('received_at', reuseExpiry)         // within its 10-min window only
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

          // Change order status back to COMPLETED
          if (entry.order_id) {
            await this.db
              .from('orders')
              .update({ status: 'COMPLETED' } as any)
              .eq('id', entry.order_id);
          }

          await this.dmUser(
            entry.user_id,
            `🔄 <b>Reuse Refund</b>\n` +
            `No OTP arrived within 22 minutes of your reuse request.\n` +
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
  private async dmUser(userId: string, html: string, replyToMsgId?: number): Promise<void> {
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
        {
          parse_mode: 'HTML',
          ...(replyToMsgId ? { reply_to_message_id: replyToMsgId } : {}),
        },
      ).catch(() => undefined);
    } catch { /* ignore */ }
  }

  // ── D: SMS poll fallback — catch missed webhooks ─────────────────────────────

  /**
   * Poll upstream for RESERVED orders to detect OTPs that arrived but
   * whose webhook was missed. When upstream status is COMPLETED but our
   * DB still says RESERVED, we know the webhook failed.
   *
   * Strategy:
   *   1. Find RESERVED orders older than 1 min (give webhook time to arrive)
   *   2. For each, call GET /v3/api/request/{id}
   *   3. If upstream status is COMPLETED → update our DB + notify user
   *   4. Rate-limit: max 10 upstream calls per sweep to stay well under 120/min
   */
  private async pollForMissedOtp(): Promise<void> {
    try {
      const minAge = new Date(Date.now() - OTP_POLL_MIN_AGE).toISOString();

      // Get RESERVED orders with a request_id (meaning purchase succeeded)
      const { data: reservedOrders } = await this.db
        .from('orders')
        .select('id,user_id,request_id,number,service_name,plan,sell_cents,purchase_msg_id')
        .eq('status', 'RESERVED')
        .not('request_id', 'is', null)
        .lt('created_at', minAge)
        .order('created_at', { ascending: false })
        .limit(10);

      if (!reservedOrders || reservedOrders.length === 0) return;

      for (const order of reservedOrders as {
        id: string;
        user_id: string;
        request_id: string;
        number: string | null;
        service_name: string;
        plan: string;
        sell_cents: number;
        purchase_msg_id: number | null;
      }[]) {
        try {
          const upstream = await this.pva.getRequest(order.request_id);

          if (upstream.status !== 'COMPLETED') continue;

          // Check how many SMS we already stored for this order
          const { count: smsCount } = await this.db
            .from('sms_messages')
            .select('id', { count: 'exact', head: true })
            .eq('order_id', order.id);

          const upstreamCodeCount = upstream.codes && upstream.codes.length > 0
            ? upstream.codes.length
            : 1;

          if ((smsCount ?? 0) >= upstreamCodeCount) {
            // All SMS already stored — just update order status if still RESERVED
            await this.db
              .from('orders')
              .update({ status: 'COMPLETED' } as any)
              .eq('id', order.id)
              .eq('status', 'RESERVED');
            continue;
          }

          // Webhook was missed! Update order status.
          await this.db
            .from('orders')
            .update({ status: 'COMPLETED' } as any)
            .eq('id', order.id);

          console.log(
            `[reconcile] ⚠️ Missed webhook detected for order ${order.id} ` +
            `(request ${order.request_id}) — upstream COMPLETED, our DB was RESERVED`,
          );

          // Extract message and pin from upstream response if available
          const latestCode = upstream.codes && upstream.codes.length > 0
            ? upstream.codes[upstream.codes.length - 1]
            : null;
          const smsBody = latestCode?.message || upstream.message || '[OTP received — webhook missed, code retrieved by poll]';
          const pin = latestCode?.pin || null;

          // Store SMS message
          await this.db.from('sms_messages').insert({
            order_id:   order.id,
            user_id:    order.user_id,
            request_id: order.request_id,
            number:     order.number ?? null,
            body:       smsBody,
          } as any);

          // Notify the user
          const { extractOtp } = await import('../domain/pricing.js');
          const otp = pin || extractOtp(smsBody);

          const isStr = !order.plan || order.plan === 'STR';
          let reuseNote = '';
          if (isStr) {
            const { data: settings } = await this.db.from('settings').select('reuse_cost_cents').single();
            const reuseCents = (settings as any)?.reuse_cost_cents ?? 80;
            reuseNote =
              `\n\n⚠️ <i>Want another OTP? Use <b>Reuse</b> in My Numbers ` +
              `(costs $${(reuseCents / 100).toFixed(2)} per request).</i>`;
          }

          const msgText = otp
            ? `📨 <b>OTP Received!</b>\n🔑 Code: <code>${otp}</code>\n\n<i>${smsBody}</i>${reuseNote}`
            : `📨 <b>OTP Received!</b>\n` +
              `Your number <code>${order.number ?? 'N/A'}</code> (${order.service_name}) received an SMS.\n\n` +
              `🔑 Check <b>My Numbers → ${order.number ?? 'your number'}</b> or tap <b>Get OTP</b> to see the code.${reuseNote}`;

          await this.dmUser(order.user_id, msgText, order.purchase_msg_id ?? undefined);

          console.log(
            `[reconcile] ✅ User notified about missed OTP for order ${order.id}`,
          );
        } catch (e) {
          // Individual order poll failed — skip (don't block other orders)
          // Common: upstream 404 for expired/flagged numbers
          if (e instanceof Error && !e.message.includes('404')) {
            console.error(
              `[reconcile] OTP poll error for order ${order.id}:`,
              e.message,
            );
          }
        }
      }
    } catch (e) {
      console.error('[reconcile] OTP poll sweep error:', e instanceof Error ? e.message : e);
    }
  }

}
