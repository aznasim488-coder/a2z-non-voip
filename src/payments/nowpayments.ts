/**
 * NOWPayments integration.
 *
 * Flow:
 *   1. User picks amount (min $3) → bot calls NOWPayments API to create payment
 *   2. Bot sends payment address + amount to user
 *   3. User sends USDT to that address
 *   4. NOWPayments calls IPN webhook when confirmed
 *   5. We credit user wallet
 *
 * IPN URL to set in NOWPayments dashboard:
 *   https://YOUR-APP.up.railway.app/webhooks/nowpayments
 *
 * Docs: https://documenter.getpostman.com/view/7907941/S1a32n38
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { creditWallet } from '../domain/wallet.js';
import { createHmac } from 'node:crypto';

const BASE_URL = 'https://api.nowpayments.io/v1';

// Minimum top-up in cents
export const MIN_TOPUP_CENTS = 300; // $3.00

export interface NowPayment {
  payment_id: string;
  payment_status: string;   // 'waiting' | 'confirming' | 'confirmed' | 'finished'
  pay_address: string;
  pay_amount: number;
  pay_currency: string;     // e.g. 'usdttrc20'
  price_amount: number;
  price_currency: string;   // 'usd'
  order_id: string;         // our metadata: "userId:amountCents"
  expiration_estimate_date: string;
}

/** Create a payment invoice via NOWPayments API */
export async function createPayment({
  apiKey,
  amountUsd,
  userId,
  ipnCallbackUrl,
}: {
  apiKey: string;
  amountUsd: number;
  userId: string;
  ipnCallbackUrl: string;
}): Promise<NowPayment> {
  const orderId = `${userId}:${Math.round(amountUsd * 100)}:${Date.now()}`;

  const res = await fetch(`${BASE_URL}/payment`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      price_amount: amountUsd,
      price_currency: 'usd',
      pay_currency: 'usdttrc20',   // USDT TRC20 — lowest fees, fast
      order_id: orderId,
      order_description: `PVADeals wallet top-up $${amountUsd.toFixed(2)}`,
      ipn_callback_url: ipnCallbackUrl,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NOWPayments API error ${res.status}: ${err}`);
  }

  return res.json() as Promise<NowPayment>;
}

/** 
 * Verify IPN signature from NOWPayments.
 * HMAC-SHA512 of the alphabetically-sorted JSON payload.
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

/** Recursively sort object keys alphabetically (required by NOWPayments) */
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
 * Process confirmed IPN from NOWPayments → credit wallet.
 * Call this from your POST /webhooks/nowpayments route.
 */
export async function processNowPaymentsIpn(
  payload: unknown,
  db: SupabaseClient,
): Promise<void> {
  const ipn = payload as {
    payment_id: string | number;
    payment_status: string;
    order_id: string;        // "userId:amountCents:timestamp"
    price_amount: number;
    actually_paid: number;
    pay_currency: string;
  };

  // Only process when fully confirmed
  // 'finished' = fully confirmed, 'confirmed' = enough confirmations
  const done = ['finished', 'confirmed'].includes(ipn.payment_status);
  if (!done) {
    console.info('[nowpayments] status', ipn.payment_status, '— skipping');
    return;
  }

  // Parse order_id: "userId:amountCents:timestamp"
  const parts = (ipn.order_id ?? '').split(':');
  const userId     = parts[0] ?? '';
  const amountCents = parseInt(parts[1] ?? '0', 10);

  if (!userId || !amountCents) {
    console.error('[nowpayments] bad order_id', ipn.order_id);
    return;
  }

  // Idempotency key = payment_id (prevents double-credit on IPN retry)
  const idempotencyKey = `nowpay_${ipn.payment_id}`;

  await creditWallet(db, {
    userId,
    amountCents,
    kind: 'topup',
    idempotencyKey,
    note: `NOWPayments ${ipn.pay_currency} — id: ${ipn.payment_id}`,
  });

  // Record topup
  await db.from('topups').insert({
    user_id: userId,
    amount_cents: amountCents,
    method: 'nowpayments',
    status: 'confirmed',
    external_id: String(ipn.payment_id),
    note: `${ipn.pay_currency} — paid: ${ipn.actually_paid}`,
  });

  console.info('[nowpayments] credited', { userId, amountCents, paymentId: ipn.payment_id });
}
