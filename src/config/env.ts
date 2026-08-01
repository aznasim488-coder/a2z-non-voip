import { z } from 'zod';

const csvIds = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.coerce.number().int().positive()));

const Schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),

    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d{6,}:[\w-]{30,}$/, 'must look like 123456789:AAA... from @BotFather'),
    BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
    ADMIN_TELEGRAM_IDS: csvIds,

    PVADEALS_API_KEY: z.string().min(8),
    PVADEALS_BASE_URL: z.string().url().default('https://prod-v3.pvadeals.com'),
    PVADEALS_WEBHOOK_SECRET: z.string().min(16),

    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

    NOWPAYMENTS_API_KEY: z.string().min(8).optional(),
    NOWPAYMENTS_IPN_SECRET: z.string().min(8).optional(),
    NOWPAYMENTS_BASE_URL: z.string().url().default('https://api.nowpayments.io'),

    // Binance Personal Account API (optional — leave blank to disable)
    // Requires: API key with Wallet READ permission only (no trading/withdraw)
    BINANCE_API_KEY:    z.string().min(4).optional(), // Personal Binance API key
    BINANCE_API_SECRET: z.string().min(4).optional(), // Personal Binance secret
    BINANCE_ID:         z.string().optional(),         // Your public Binance ID (shown to users)

    // bKash Merchant API (optional — leave blank to disable)
    BKASH_APP_KEY:      z.string().optional(),
    BKASH_APP_SECRET:   z.string().optional(),
    BKASH_USERNAME:     z.string().optional(),
    BKASH_PASSWORD:     z.string().optional(),
    BKASH_BASE_URL:     z.string().url().default('https://tokenized.pay.bka.sh/v1.2.0-beta'),
    BKASH_NUMBER_SMALL: z.string().optional(), // bKash number for < limit TK
    BKASH_NUMBER_LARGE: z.string().optional(), // bKash number for >= limit TK
    BKASH_LIMIT_TK:     z.coerce.number().default(500),   // threshold between numbers
    BKASH_RATE_TK:      z.coerce.number().default(130),   // TK per $1 USD
    BKASH_MIN_TK:       z.coerce.number().default(390),   // minimum deposit in TK ($3)
    BKASH_SMS_SECRET:   z.string().optional(),             // webhook auth token for SMS forwarder
  })
  .superRefine((v, ctx) => {
    if (v.BOT_MODE === 'webhook') {
      if (!v.TELEGRAM_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TELEGRAM_WEBHOOK_SECRET'],
          message: 'required when BOT_MODE=webhook',
        });
      }
      if (!v.PUBLIC_BASE_URL.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PUBLIC_BASE_URL'],
          message: 'must be https when BOT_MODE=webhook',
        });
      }
    }
    const hasKey = Boolean(v.NOWPAYMENTS_API_KEY);
    const hasSec = Boolean(v.NOWPAYMENTS_IPN_SECRET);
    if (hasKey !== hasSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasKey ? 'NOWPAYMENTS_IPN_SECRET' : 'NOWPAYMENTS_API_KEY'],
        message: 'set both NOWPayments values or neither',
      });
    }
  });

export type Env = z.infer<typeof Schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = Schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    console.error('Bad environment:\n' + lines.join('\n'));
    process.exit(1);
  }
  return result.data;
}

export function isAdmin(env: Env, telegramId: number | undefined): boolean {
  return telegramId != null && env.ADMIN_TELEGRAM_IDS.includes(telegramId);
}

export const nowPaymentsEnabled = (env: Env): boolean =>
  Boolean(env.NOWPAYMENTS_API_KEY && env.NOWPAYMENTS_IPN_SECRET);

export const binancePayEnabled = (env: Env): boolean =>
  Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET && env.BINANCE_ID);

export const bkashEnabled = (env: Env): boolean =>
  Boolean(
    env.BKASH_APP_KEY && env.BKASH_APP_SECRET &&
    env.BKASH_USERNAME && env.BKASH_PASSWORD &&
    env.BKASH_NUMBER_SMALL && env.BKASH_NUMBER_LARGE,
  );
