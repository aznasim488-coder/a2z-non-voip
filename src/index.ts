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

// Raw body — signature verification for Telegram webhook + NOWPayments IPN
app.addContentTypeParser(
  ['application/json', 'text/plain'],
  { parseAs: 'buffer' },
  (_req, body: Buffer, done) => {
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (e) {
      done(e as Error, undefined);
    }
  },
);

// ─── Routes ───────────────────────────────────────────────────────────────────

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
        const { data: order } = await db
          .from('orders')
          .select('id, user_id, profiles!inner(telegram_id)')
          .eq('request_id', event.requestId)
          .single();

        if (order) {
          const orderId = (order as any).id as string;
          const userId  = (order as any).user_id as string;
          const tid     = (order as any).profiles.telegram_id as number;

          // 1. Store SMS message
          await db.from('sms_messages').insert({
            order_id:   orderId,
            user_id:    userId,
            request_id: event.requestId,
            number:     event.number ?? null,
            body:       event.message,
          } as any);

          // 2. Mark order COMPLETED (OTP arrived)
          await db.from('orders')
            // @ts-ignore
            .update({ status: 'COMPLETED' })
            .eq('id', orderId);

          // 3. Notify user
          const { extractOtp } = await import('./domain/pricing.js');
          const otp = extractOtp(event.message);
          const msgText = otp
            ? `📨 <b>OTP Received!</b>\n🔑 Code: <code>${otp}</code>\n\n<i>${event.message}</i>`
            : `📨 <b>SMS Received:</b>\n<i>${event.message}</i>`;

          await bot.api.sendMessage(tid, msgText, { parse_mode: 'HTML' }).catch(() => undefined);
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
  const reconcile = new ReconcileSweep(db, pva);
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
