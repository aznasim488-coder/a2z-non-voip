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
