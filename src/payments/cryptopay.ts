/**
 * CryptoPay payment handler.
 *
 * Flow:
 *   1. User taps "Top Up" → picks amount
 *   2. Bot creates invoice via CryptoPay API
 *   3. Bot sends the invoice link
 *   4. User pays in Telegram (@CryptoBot)
 *   5. CryptoPay calls our webhook → we credit wallet
 *
 * API docs: https://help.crypt.bot/crypto-pay-api
 * Fee: 0.25% per transaction (lowest in the market)
 */

import type { BotContext } from '../bot/middleware.js';
import { creditWallet } from '../domain/wallet.js';
import { formatCents } from '../domain/money.js';
import { InlineKeyboard } from 'grammy';
import { createHash, createHmac } from 'node:crypto';

const BASE_URL = 'https://pay.crypt.bot/api'; // mainnet
// const BASE_URL = 'https://testnet-pay.crypt.bot/api'; // testnet for testing

interface CryptoPayInvoice {
  invoice_id: number;
  status: string;        // 'active' | 'paid' | 'expired'
  hash: string;
  asset: string;
  amount: string;
  pay_url: string;
  bot_invoice_url: string;
  mini_app_invoice_url: string;
  created_at: string;
  payload?: string;
}

/** Create an invoice via CryptoPay API */
async function createInvoice(token: string, {
  asset,
  amount,
  description,
  payload,
  expiresIn = 3600, // 1 hour
}: {
  asset: string;
  amount: string;
  description: string;
  payload: string;
  expiresIn?: number;
}): Promise<CryptoPayInvoice> {
  const res = await fetch(`${BASE_URL}/createInvoice`, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      asset,
      amount,
      description,
      payload,
      expires_in: expiresIn,
    }),
  });

  const json = await res.json() as { ok: boolean; result: CryptoPayInvoice; error?: { code: number; name: string } };

  if (!json.ok) {
    throw new Error(`CryptoPay error: ${json.error?.name ?? 'unknown'}`);
  }

  return json.result;
}

/** Show top-up options — user picks amount and currency */
export async function handleCryptoTopup(ctx: BotContext, amountUsd: number): Promise<void> {
  const token = process.env['CRYPTOPAY_TOKEN'];
  if (!token) {
    await ctx.reply('❌ Crypto payments not configured. Contact admin.');
    return;
  }

  // USDT is best — 1:1 with USD, no volatility
  const asset = 'USDT';
  const amountStr = amountUsd.toFixed(2);

  // Payload = userId:amountCents for webhook to use
  const payload = `${ctx.user.id}:${Math.round(amountUsd * 100)}`;

  try {
    const invoice = await createInvoice(token, {
      asset,
      amount: amountStr,
      description: `Top up PVADeals wallet — $${amountStr} USDT`,
      payload,
    });

    const kb = new InlineKeyboard()
      .url(`💳 Pay $${amountStr} USDT`, invoice.bot_invoice_url);

    await ctx.reply(
      `💳 <b>Top Up — $${amountStr}</b>\n` +
      `──────────────────\n` +
      `Amount: <b>${amountStr} USDT</b>\n` +
      `Fee: <b>0.25%</b> (charged by CryptoPay)\n\n` +
      `Tap the button below to pay via <b>@CryptoBot</b>.\n` +
      `After payment your wallet will be credited automatically.\n\n` +
      `<i>Invoice expires in 1 hour.</i>`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    await ctx.reply(`❌ Could not create invoice: ${msg}`);
  }
}

/** 
 * Process incoming CryptoPay webhook.
 * Call this from your Fastify route:
 *   POST /webhooks/cryptopay
 */
export async function processCryptoPayWebhook(
  body: unknown,
  token: string,
  db: import('@supabase/supabase-js').SupabaseClient,
): Promise<void> {
  const event = body as {
    update_type: string;
    update_id: number;
    request_date: string;
    payload: {
      invoice_id: number;
      hash: string;
      status: string;     // 'paid'
      asset: string;
      amount: string;
      payload?: string;   // our custom payload: "userId:amountCents"
      paid_at?: string;
    };
  };

  if (event.update_type !== 'invoice_paid') return;

  const invoice = event.payload;
  if (invoice.status !== 'paid') return;

  // Parse our payload
  const parts = (invoice.payload ?? '').split(':');
  const userId = parts[0];
  const amountCents = parseInt(parts[1] ?? '0', 10);

  if (!userId || !amountCents) {
    console.error('[cryptopay] bad payload', invoice.payload);
    return;
  }

  // Idempotency key = invoice hash (prevents double-credit on webhook retry)
  const idempotencyKey = `cryptopay_${invoice.hash}`;

  try {
    // Credit the wallet
    await creditWallet(db, {
      userId,
      amountCents,
      kind: 'topup',
      idempotencyKey,
      note: `CryptoPay ${invoice.asset} — invoice #${invoice.invoice_id}`,
    });

    // Record the topup
    await db.from('topups').insert({
      user_id: userId,
      amount_cents: amountCents,
      method: 'nowpayments',  // reuse existing enum value (crypto)
      status: 'confirmed',
      external_id: String(invoice.invoice_id),
      note: `CryptoPay ${invoice.asset} ${invoice.amount} — hash: ${invoice.hash}`,
    });

    console.info('[cryptopay] credited', { userId, amountCents, invoiceId: invoice.invoice_id });
  } catch (e) {
    // Idempotency key prevents double credit — error here means already processed
    console.warn('[cryptopay] credit failed (may be duplicate)', e);
  }
}

/** Verify webhook came from CryptoPay (HMAC SHA-256) */
export function verifyCryptoPayWebhook(
  rawBody: string,
  token: string,
  receivedHeader: string,
): boolean {
  const secret = createHash('sha256').update(token).digest();
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  return computed === receivedHeader;
}
