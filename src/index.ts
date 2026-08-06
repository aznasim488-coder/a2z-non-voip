import 'dotenv/config';
import Fastify from 'fastify';
import { run } from '@grammyjs/runner';
import { webhookCallback } from 'grammy';

import { loadEnv } from './config/env.js';
import { getDb } from './db/index.js';
import { PvaDealsClient } from './upstream/client.js';
import { createBot } from './bot/index.js';
import { CatalogSync } from './jobs/catalog-sync.js';
import { BalanceWatch } from './jobs/balance-watch.js';
import { ReconcileSweep } from './jobs/reconcile.js';
import { processNowPaymentsIpn, verifyIpnSignature } from './payments/nowpayments.js';
import { parseBkashSms, tkToCents } from './payments/bkash.js';
import { creditWallet } from './domain/wallet.js';
import { formatCents } from './domain/money.js';
import cors from '@fastify/cors';
import { registerApiRoutes } from './api/routes.js';


const env = loadEnv();
const db = getDb(env);
const pva = PvaDealsClient.fromEnv(env);

const bot = createBot(env.TELEGRAM_BOT_TOKEN, db, pva, env);

// ─── Fastify ──────────────────────────────────────────────────────────────────

const app = Fastify({
  logger: {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
  },
  trustProxy: true,
});

// Universal body parser — accept ANY Content-Type (including missing headers).
// PVADeals webhooks arrive without standard Content-Type; we must not reject them.
app.removeAllContentTypeParsers();
app.addContentTypeParser(
  '*',
  { parseAs: 'buffer' },
  (_req, body: Buffer, done) => {
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(null, { raw: body.toString('utf8') });
    }
  },
);

// ─── Routes ───────────────────────────────────────────────────────────────────

// CORS for website frontend
await app.register(cors, { origin: true, credentials: true });

// REST API for website
registerApiRoutes(app, db, pva, env);

app.get('/health', async () => ({ ok: true, mode: env.BOT_MODE }));


// NOWPayments IPN webhook — HMAC-SHA512 verified
app.post('/webhooks/nowpayments', async (req, reply) => {
  const ipnSecret = env.NOWPAYMENTS_IPN_SECRET;
  if (!ipnSecret) return reply.code(404).send();

  const sig = (req.headers['x-nowpayments-sig'] as string) ?? '';

  if (!verifyIpnSignature(req.body, sig, ipnSecret)) {
    app.log.warn('NOWPayments IPN: invalid signature');
    return reply.code(401).send({ error: 'invalid signature' });
  }

  try {
    await processNowPaymentsIpn(req.body, db);
  } catch (e) {
    app.log.error({ err: e }, 'NOWPayments IPN processing error');
  }
  return reply.send({ ok: true });
});

// bKash SMS webhook — called by Android SMS-forwarder app on the bKash SIM
// Webhook URL: POST /webhooks/bkash-sms?secret=BKASH_SMS_SECRET
// Body (JSON): { "text": "Tk 250.00 received from 01XX... Ref ABC123..." }
// Compatible with: SMS Forwarder, SMS Gateway Hub, or any similar app
app.post('/webhooks/bkash-sms', async (req, reply) => {
  const secret = env.BKASH_SMS_SECRET;
  // If a secret is configured, require it as a query param
  if (secret) {
    const qs = (req.query as Record<string, string>)?.secret;
    if (qs !== secret) {
      app.log.warn('[bkash-sms] invalid secret');
      return reply.code(401).send({ error: 'unauthorized' });
    }
  }

  // Accept both: { text: '...' } and { message: '...' } and { body: '...' }
  const body = req.body as Record<string, unknown>;
  const smsText = (
    (body?.text ?? body?.message ?? body?.body ?? body?.sms ?? '') as string
  ).trim();

  app.log.info({ smsText }, '[bkash-sms] received');

  const parsed = parseBkashSms(smsText);
  if (!parsed) {
    app.log.info('[bkash-sms] not a payment SMS — ignored');
    return reply.send({ ok: true, action: 'ignored' });
  }

  const { trxId, amountTk } = parsed;
  app.log.info({ trxId, amountTk }, '[bkash-sms] parsed payment');

  // Find pending topup with this TrxID
  const { data: topup } = await db
    .from('topups')
    .select('id, user_id, amount_cents, note')
    .eq('external_id', trxId)
    .eq('method', 'bkash')
    .eq('status', 'pending')
    .maybeSingle();

  if (!topup) {
    app.log.warn({ trxId }, '[bkash-sms] no pending topup found for TrxID');
    return reply.send({ ok: true, action: 'no_match' });
  }

  const rateTk       = env.BKASH_RATE_TK;
  const amountCents  = tkToCents(amountTk, rateTk);
  const idempotKey   = `bkash_${trxId}`;

  // Idempotency: skip if already credited
  const { data: existing } = await db
    .from('ledger_entries')
    .select('id')
    .eq('idempotency_key', idempotKey)
    .maybeSingle();

  if (existing) {
    app.log.info({ trxId }, '[bkash-sms] already credited — skipping');
    return reply.send({ ok: true, action: 'already_credited' });
  }

  try {
    const t = topup as any;
    // Credit wallet
    await creditWallet(db, {
      userId:         t.user_id as string,
      amountCents,
      kind:           'topup',
      idempotencyKey: idempotKey,
      note:           `bKash auto TrxID: ${trxId} — ${amountTk} TK`,
    });

    // Update topup record
    await (db.from('topups') as any)
      .update({ status: 'confirmed', amount_cents: amountCents })
      .eq('id', t.id);

    // Get user telegram_id to notify
    const { data: userRow } = await db
      .from('users')
      .select('telegram_id, balance_cents')
      .eq('id', t.user_id as string)
      .maybeSingle();

    if (userRow) {
      const ur = userRow as any;
      const newBal = formatCents(ur.balance_cents as number);
      const amountUsd = (amountCents / 100).toFixed(2);
      await bot.api.sendMessage(
        ur.telegram_id as number,
        `✅ <b>bKash Payment Verified! (Auto)</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📋 TrxID: <code>${trxId}</code>\n` +
        `💵 ${amountTk} TK = <b>$${amountUsd}</b> credited\n` +
        `💳 New balance: <b>${newBal}</b>\n\n` +
        `আপনার wallet এ টাকা যোগ হয়েছে! 🎉`,
        { parse_mode: 'HTML' },
      ).catch(() => undefined);
    }

    app.log.info({ trxId, amountTk, amountCents }, '[bkash-sms] ✅ auto-credited');
  } catch (e) {
    app.log.error({ err: e, trxId }, '[bkash-sms] credit failed');
  }

  return reply.send({ ok: true, action: 'credited' });
});

// Telegram webhook — grammY handles updates, secret token verified
// Route registered regardless of mode so it's ready when we switch
app.post(
  `/webhooks/telegram/${env.TELEGRAM_WEBHOOK_SECRET}`,
  webhookCallback(bot, 'fastify', {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
    timeoutMilliseconds: 10_000,
  }),
);

app.post(
  `/webhooks/pvadeals/${env.PVADEALS_WEBHOOK_SECRET}`,
  async (req, reply) => {
    const event = req.body as {
      event?: string;
      requestId?: string;
      oldRequestId?: string;
      serviceId?: string;
      number?: string;
      message?: string;
      newExpiresAt?: string;
    };

    app.log.info({ event: event.event, requestId: event.requestId }, 'pvadeals webhook received');

    try {
      if (event.event === 'sms_received' && event.requestId && event.message) {
        app.log.info(`[pvadeals] sms_received — requestId=${event.requestId} number=${event.number ?? '?'}`);

        // ── 1. Look up order by request_id (primary) ────────────────────────
        let order: Record<string, unknown> | null = null;

        const { data: orderByReqId, error: orderErr } = await db
          .from('orders')
          .select('id, user_id, plan, purchase_msg_id')
          .eq('request_id', event.requestId)
          .maybeSingle();

        if (orderErr) {
          app.log.error(`[pvadeals] DB error looking up order for requestId=${event.requestId}: ${orderErr.message}`);
        }

        order = orderByReqId as Record<string, unknown> | null;

        // ── 1b. Fallback: look up by phone number (handles race condition    
        //    where webhook arrives before updateOrderSuccess writes request_id)
        if (!order && event.number) {
          const { data: orderByNumber } = await db
            .from('orders')
            .select('id, user_id, plan, purchase_msg_id, request_id')
            .eq('number', event.number)
            .in('status', ['RESERVED', 'PENDING_UPSTREAM'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (orderByNumber) {
            order = orderByNumber as Record<string, unknown>;
            app.log.info(`[pvadeals] Found order by number fallback: orderId=${(order as any).id}`);

            // Also store the request_id if it was missing (race condition fix)
            if (!(orderByNumber as any).request_id) {
              await db.from('orders')
                // @ts-ignore
                .update({ request_id: event.requestId })
                .eq('id', (orderByNumber as any).id);
              app.log.info(`[pvadeals] Stored missing request_id=${event.requestId} on order`);
            }
          }
        }

        if (!order) {
          app.log.warn(`[pvadeals] ⚠️ No order found for requestId=${event.requestId} number=${event.number ?? '?'} — OTP NOT delivered`);
        } else {
          const orderId       = (order as any).id as string;
          const userId        = (order as any).user_id as string;
          const orderPlan     = (order as any).plan as string | undefined;
          const purchaseMsgId = (order as any).purchase_msg_id as number | null | undefined;

          // ── 2. Look up telegram_id from profiles (separate query — avoids join issues) ──
          const { data: profile } = await db
            .from('profiles')
            .select('telegram_id')
            .eq('id', userId)
            .maybeSingle();

          if (!profile) {
            app.log.warn({ userId, orderId }, '[pvadeals] ⚠️ No profile found for user — cannot notify');
          } else {
            const tid = (profile as any).telegram_id as number;

            // ── 3. Store SMS message ─────────────────────────────────────────
            await db.from('sms_messages').insert({
              order_id:   orderId,
              user_id:    userId,
              request_id: event.requestId,
              number:     event.number ?? null,
              body:       event.message,
            } as any);

            // ── 4. Mark order COMPLETED ──────────────────────────────────────
            await db.from('orders')
              // @ts-ignore
              .update({ status: 'COMPLETED' })
              .eq('id', orderId);

            // ── 5. Build notification message ────────────────────────────────
            const { extractOtp } = await import('./domain/pricing.js');
            const otp = extractOtp(event.message);

            const isStr = !orderPlan || orderPlan === 'STR';
            let reuseNote = '';
            if (isStr) {
              const { data: settings } = await db.from('settings').select('reuse_cost_cents').single();
              const reuseCents = (settings as any)?.reuse_cost_cents ?? 80;
              reuseNote = `\n\n⚠️ <i>Want another OTP? Use <b>Reuse</b> in My Numbers (costs $${(reuseCents / 100).toFixed(2)} per request).</i>`;
            }

            const msgText = otp
              ? `📨 <b>OTP Received!</b>\n🔑 Code: <code>${otp}</code>\n\n<i>${event.message}</i>${reuseNote}`
              : `📨 <b>SMS Received:</b>\n<i>${event.message}</i>${reuseNote}`;

            // ── 6. Send to user (reply to purchase message if saved) ─────────
            await bot.api.sendMessage(tid, msgText, {
              parse_mode: 'HTML',
              ...(purchaseMsgId ? { reply_to_message_id: purchaseMsgId } : {}),
            }).catch((err: unknown) => {
              app.log.warn({ err, tid }, '[pvadeals] sendMessage failed (user may have blocked bot)');
            });

            app.log.info({ orderId, otp, tid }, '[pvadeals] ✅ OTP delivered to user');
          }
        }
      }

      if (event.event === 'number_renewed' && event.oldRequestId && event.requestId) {
        await db
          .from('orders')
          // @ts-ignore
          .update({ request_id: event.requestId, end_time: event.newExpiresAt ?? null })
          .eq('request_id', event.oldRequestId);
      }

      if (event.event === 'number_flagged' && event.requestId) {
        await db.from('orders')
          // @ts-ignore
          .update({ status: 'CANCELLED' })
          .eq('request_id', event.requestId);
      }
    } catch (e) {
      app.log.error({ err: e }, 'pvadeals webhook processing error');
    }

    return reply.code(200).send({ ok: true });
  },
);

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Start background services
  pva.health.start();

  const catalogSync = new CatalogSync(db, pva);
  const reconcile = new ReconcileSweep(db, pva, bot, env);
  const balanceWatch = new BalanceWatch(db, pva, bot, env);

  catalogSync.start();
  reconcile.start();
  balanceWatch.start();

  // Start bot in polling mode (dev) or register webhook (prod)
  if (env.BOT_MODE === 'polling') {
    run(bot);
    console.log('Bot started in polling mode');
  } else {
    const webhookUrl = `${env.PUBLIC_BASE_URL}/webhooks/telegram/${env.TELEGRAM_WEBHOOK_SECRET}`;
    await bot.api.setWebhook(webhookUrl, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
    });
    app.log.info({ webhookUrl }, 'Telegram webhook registered');
  }

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(
    { port: env.PORT, mode: env.BOT_MODE, admins: env.ADMIN_TELEGRAM_IDS.length },
    'Server started',
  );
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'Shutting down');
    pva.health.stop();
    void app.close().then(() => process.exit(0));
  });
}
