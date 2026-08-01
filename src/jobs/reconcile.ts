/**
 * Reconciliation sweep — heals PENDING_UPSTREAM orders older than 90 s.
 * If server crashed between debitWallet and updateOrderSuccess, this finds
 * the upstream requestId or issues an auto-refund.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PvaDealsClient } from '../upstream/client.js';
import { getPendingOrders, updateOrderSuccess, updateOrderFailed } from '../domain/orders.js';
import { creditWallet } from '../domain/wallet.js';

const SWEEP_MS = 90_000;
const STALE_MS = 90_000;

export class ReconcileSweep {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: SupabaseClient,
    private readonly pva: PvaDealsClient,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

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
}
