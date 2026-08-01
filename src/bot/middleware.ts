/**
 * Bot middleware — runs on every update before handlers.
 *
 * 1. Upserts the Telegram user into profiles + wallets via the
 *    upsert_telegram_user() Postgres function.
 * 2. Attaches ctx.user (profile row) and ctx.db, ctx.pva, ctx.env
 *    to the context for downstream handlers.
 * 3. Answers callback_query immediately to clear the Telegram spinner.
 * 4. Simple per-user rate limiter (500ms cooldown) to prevent DB spam.
 */

import type { Context, NextFunction } from 'grammy';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PvaDealsClient } from '../upstream/client.js';
import type { Env } from '../config/env.js';

export interface UserProfile {
  id: string;
  telegram_id: number;
  username: string | null;
  first_name: string;
  role: 'customer' | 'admin';
  is_banned: boolean;
}

// Extend grammY context
export interface BotContext extends Context {
  user: UserProfile;
  db: SupabaseClient;
  pva: PvaDealsClient;
  env: Env;
}

// In-memory rate limiter — 500ms cooldown per user
const _lastSeen = new Map<number, number>();

/** Upsert user and attach to ctx. Blocks banned users. */
export function userMiddleware(
  db: SupabaseClient,
  pva: PvaDealsClient,
  env: Env,
) {
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    ctx.db = db;
    ctx.pva = pva;
    ctx.env = env;

    const from = ctx.from;
    if (!from) { await next(); return; }

    // Auto-answer callback queries immediately to clear the Telegram spinner
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => undefined);
    }

    // Rate limit: 500ms per user (prevents DB spam from button mashing)
    const now = Date.now();
    const last = _lastSeen.get(from.id) ?? 0;
    if (now - last < 500 && ctx.callbackQuery) {
      return; // silently drop — spinner already cleared above
    }
    _lastSeen.set(from.id, now);

    // Upsert via Postgres function (handles race conditions atomically)
    const { data, error } = await db.rpc('upsert_telegram_user', {
      p_telegram_id: from.id,
      p_username: from.username ?? null,
      p_first_name: from.first_name,
      p_last_name: from.last_name ?? null,
    });

    if (error || !data) {
      await ctx.reply('⚠️ Service temporarily unavailable. Please try again.').catch(() => undefined);
      return;
    }

    const profile = data as UserProfile;

    if (profile.is_banned) {
      await ctx.reply('❌ Your account has been suspended. Contact support.').catch(() => undefined);
      return;
    }

    ctx.user = profile;
    await next();
  };
}
