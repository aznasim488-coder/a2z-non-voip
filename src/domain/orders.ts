/**
 * Orders domain — creates, updates, and reconciles orders.
 *
 * Purchase flow (idempotent):
 *   1. debitWallet  (idempotency_key = callback_query.id)
 *   2. create order (status PENDING_UPSTREAM)
 *   3. call upstream purchase
 *   4. update order (status from upstream) + store requestId
 *   5. on failure → credit_wallet refund with same idempotency_key + "_refund"
 *
 * The reconcile sweep runs every 90 s to catch PENDING_UPSTREAM orders whose
 * upstream call may have succeeded after the bot process crashed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type OrderStatus =
  | 'PENDING_UPSTREAM'
  | 'RESERVED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'FAILED';

export interface CreateOrderOpts {
  userId: string;
  serviceId: string;
  serviceName: string;
  plan: string;
  sellCents: number;
  costCents: number;
  idempotencyKey: string;
}

export interface OrderRow {
  id: string;
  user_id: string;
  service_id: string;
  service_name: string;
  plan: string;
  sell_cents: number;
  cost_cents: number;
  status: OrderStatus;
  request_id: string | null;
  number: string | null;
  end_time: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export async function createOrder(
  db: SupabaseClient,
  opts: CreateOrderOpts,
): Promise<OrderRow> {
  const { data, error } = await db
    .from('orders')
    .insert({
      user_id: opts.userId,
      service_id: opts.serviceId,
      service_name: opts.serviceName,
      plan: opts.plan,
      sell_cents: opts.sellCents,
      cost_cents: opts.costCents,
      status: 'PENDING_UPSTREAM',
      idempotency_key: opts.idempotencyKey,
    })
    .select()
    .single();

  if (error) throw new Error(`createOrder failed: ${error.message}`);
  return data as OrderRow;
}

export async function updateOrderSuccess(
  db: SupabaseClient,
  orderId: string,
  opts: {
    requestId: string;
    number: string;
    status: OrderStatus;
    endTime: string;
  },
): Promise<void> {
  const { error } = await db
    .from('orders')
    .update({
      status: opts.status,
      request_id: opts.requestId,
      number: opts.number,
      end_time: opts.endTime,
    })
    .eq('id', orderId);

  if (error) throw new Error(`updateOrderSuccess failed: ${error.message}`);
}

export async function updateOrderFailed(
  db: SupabaseClient,
  orderId: string,
  reason: string,
): Promise<void> {
  const { error } = await db
    .from('orders')
    .update({ status: 'FAILED', failure_reason: reason })
    .eq('id', orderId);

  if (error) throw new Error(`updateOrderFailed failed: ${error.message}`);
}

/** Returns PENDING_UPSTREAM orders older than `ageMs` milliseconds. */
export async function getPendingOrders(
  db: SupabaseClient,
  ageMs = 90_000,
): Promise<OrderRow[]> {
  const cutoff = new Date(Date.now() - ageMs).toISOString();
  const { data, error } = await db
    .from('orders')
    .select('*')
    .eq('status', 'PENDING_UPSTREAM')
    .lt('created_at', cutoff);

  if (error) throw new Error(`getPendingOrders failed: ${error.message}`);
  return (data ?? []) as OrderRow[];
}

export async function getOrdersByUser(
  db: SupabaseClient,
  userId: string,
  limit = 10,
): Promise<OrderRow[]> {
  const { data, error } = await db
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .not('status', 'eq', 'PENDING_UPSTREAM')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getOrdersByUser failed: ${error.message}`);
  return (data ?? []) as OrderRow[];
}
