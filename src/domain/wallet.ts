/**
 * Wallet operations — thin wrappers around the debit_wallet / credit_wallet
 * Postgres functions defined in the migration.
 *
 * debit_wallet SQLSTATE codes:
 *   PVA01 — insufficient funds (also raised for negative/null amount)
 *   PVA02 — no wallet row found for user
 *
 * Idempotency: both functions fast-path return the existing balance_after
 * when the idempotency_key was already recorded. This means double-taps and
 * Telegram retries collapse to one charge automatically.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatCents } from './money.js';

export class InsufficientFundsError extends Error {
  constructor(public readonly balanceCents: number) {
    super(`Insufficient balance. Current balance: ${formatCents(balanceCents)}`);
    this.name = 'InsufficientFundsError';
  }
}

export class WalletNotFoundError extends Error {
  constructor() {
    super('No wallet found. Please contact support.');
    this.name = 'WalletNotFoundError';
  }
}

/** Debit user wallet. Returns new balance_after in cents. */
export async function debitWallet(
  db: SupabaseClient,
  opts: {
    userId: string;
    amountCents: number;
    kind: string;
    idempotencyKey: string;
    orderId?: string;
    note?: string;
  },
): Promise<number> {
  const { data, error } = await db.rpc('debit_wallet', {
    p_user_id: opts.userId,
    p_amount_cents: opts.amountCents,
    p_kind: opts.kind,
    p_idempotency_key: opts.idempotencyKey,
    p_order_id: opts.orderId ?? null,
    p_note: opts.note ?? null,
  });

  if (error) {
    if (error.code === 'PVA01') throw new InsufficientFundsError(0);
    if (error.code === 'PVA02') throw new WalletNotFoundError();
    throw new Error(`debit_wallet failed: ${error.message}`);
  }

  return Number(data);
}

/** Credit user wallet. Returns new balance_after in cents. */
export async function creditWallet(
  db: SupabaseClient,
  opts: {
    userId: string;
    amountCents: number;
    kind: string;
    idempotencyKey: string;
    topupId?: string;
    note?: string;
    createdBy?: string;
  },
): Promise<number> {
  const { data, error } = await db.rpc('credit_wallet', {
    p_user_id: opts.userId,
    p_amount_cents: opts.amountCents,
    p_kind: opts.kind,
    p_idempotency_key: opts.idempotencyKey,
    p_topup_id: opts.topupId ?? null,
    p_note: opts.note ?? null,
    p_created_by: opts.createdBy ?? null,
  });

  if (error) {
    if (error.code === 'PVA02') throw new WalletNotFoundError();
    throw new Error(`credit_wallet failed: ${error.message}`);
  }

  return Number(data);
}

/** Get current wallet balance in cents for a user by telegram_id. */
export async function getBalanceCents(
  db: SupabaseClient,
  telegramId: number,
): Promise<number> {
  const { data, error } = await db
    .from('wallets')
    .select('balance_cents, profiles!inner(telegram_id)')
    .eq('profiles.telegram_id', telegramId)
    .single();

  if (error || !data) return 0;
  return Number((data as { balance_cents: number }).balance_cents);
}
