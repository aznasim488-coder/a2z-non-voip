/**
 * NOWPayments integration — Invoice (hosted payment page).
 *
 * Flow:
 *   1. User picks amount → bot creates invoice via POST /v1/invoice
 *   2. Bot sends invoice_url button → user taps → NOWPayments hosted page opens
 *   3. User picks their preferred crypto (BTC, ETH, USDT, LTC, etc.) and pays
 *   4. NOWPayments calls our IPN webhook when payment confirmed
 *   5. We credit user wallet automatically
 *
 * IPN URL to set in NOWPayments dashboard → Settings:
 *   https://YOUR-APP.up.railway.app/webhooks/nowpayments
 *
 * Docs: https://documenter.getpostman.com/view/7907941/S1a32n38
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { creditWallet } from '../domain/wallet.js';
import { createHmac } from 'node:crypto';

const BASE_URL = 'https://api.nowpayments.io/v1';

// Minimum top-up in cents ($3.00)
export const MIN_TOPUP_CENTS = 300;

export interface NowInvoice {
  id: string;
  token_id: string;
  order_id: string;
  order_description: string;
  price_amount: string;
  price_currency: string;
  pay_currency: string | null;
  ipn_callback_url: string;
  invoice_url: string;      // ← user opens this to pick crypto & pay
  success_url?: string;
  cancel_url?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Create a hosted invoice.
 * User opens invoice_url → picks any crypto → pays on NOWPayments site.
 */
export async function createInvoice({
  apiKey,
  amountUsd,
  userId,
  amountCents,
  ipnCallbackUrl,
}: {
  apiKey: string;
  amountUsd: number;
  userId: string;
  amountCents: number;
  ipnCallbackUrl: string;
}): Promise<NowInvoice> {
  const orderId = `${userId}:${amountCents}:${Date.now()}`;

  const res = await fetch(`${BASE_URL}/invoice`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      price_amount: amountUsd,
      price_currency: 'usd',
      order_id: orderId,
      order_description: `A2Z Non-VoIP wallet top-up — $${amountUsd.toFixed(2)}`,
      ipn_callback_url: ipnCallbackUrl,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NOWPayments API ${res.status}: ${err}`);
  }

  const body = await res.json() as NowInvoice;
  return body;
}

/**
 * Verify IPN signature — HMAC-SHA512 of alphabetically sorted JSON payload.
 * Header: x-nowpayments-sig
 */
export function verifyIpnSignature(
  rawPayload: unknown,
  receivedSig: string,
  ipnSecret: string,
): boolean {
  const sorted = sortObjectKeys(rawPayload as Record<string, unknown>);
  const sig = createHmac('sha512', ipnSecret)
    .update(JSON.stringify(sorted))
    .digest('hex');
  return sig === receivedSig;
}

/** Recursively sort object keys alphabetically (required by NOWPayments IPN spec) */
function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      const val = obj[key];
      acc[key] = val && typeof val === 'object' && !Array.isArray(val)
        ? sortObjectKeys(val as Record<string, unknown>)
        : val;
      return acc;
    }, {} as Record<string, unknown>);
}

/**
 * Process confirmed IPN from NOWPayments → credit user wallet.
 * Called from POST /webhooks/nowpayments route.
 */
export async function processNowPaymentsIpn(
  payload: unknown,
  db: SupabaseClient,
): Promise<void> {
  const ipn = payload as {
    payment_id: string | number;
    payment_status: string;
    order_id: string;         // "userId:amountCents:timestamp"
    price_amount: number;
    actually_paid?: number;
    pay_currency: string;
  };

  // Only credit on final confirmed statuses
  const creditStatuses = ['finished', 'confirmed'];
  if (!creditStatuses.includes(ipn.payment_status)) {
    console.info('[nowpayments] status', ipn.payment_status, '— not crediting yet');
    return;
  }

  // Parse order_id: "userId:amountCents:timestamp"
  const parts = (ipn.order_id ?? '').split(':');
  const userId      = parts[0] ?? '';
  const amountCents = parseInt(parts[1] ?? '0', 10);

  if (!userId || !amountCents || amountCents < 1) {
    console.error('[nowpayments] invalid order_id', ipn.order_id);
    return;
  }

  // Idempotency key = payment_id (prevents double-credit on IPN retry)
  const idempotencyKey = `nowpay_${ipn.payment_id}`;

  try {
    await creditWallet(db, {
      userId,
      amountCents,
      kind: 'topup',
      idempotencyKey,
      note: `NOWPayments ${ipn.pay_currency} ✅ — id: ${ipn.payment_id}`,
    });

    await db.from('topups').insert({
      user_id: userId,
      amount_cents: amountCents,
      method: 'nowpayments',
      status: 'confirmed',
      external_id: String(ipn.payment_id),
      note: `${ipn.pay_currency} — paid: ${ipn.actually_paid ?? '?'}`,
    });

    console.info('[nowpayments] ✅ credited', { userId, amountCents, paymentId: ipn.payment_id });
  } catch (e) {
    // Idempotency key prevents double-credit — safe to ignore duplicate
    console.warn('[nowpayments] credit skipped (duplicate?)', (e as Error).message);
  }
}
