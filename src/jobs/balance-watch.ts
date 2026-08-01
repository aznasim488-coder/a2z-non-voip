/**
 * Balance watch — polls upstream balance every 60 s.
 * Warns admins at warn threshold, pauses purchases at floor threshold.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PvaDealsClient } from '../upstream/client.js';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot/middleware.js';
import type { Env } from '../config/env.js';
import { formatCents } from '../domain/money.js';

const POLL_MS = 60_000;

export class BalanceWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private warnSent = false;
  private floorReached = false;

  constructor(
    private readonly db: SupabaseClient,
    private readonly pva: PvaDealsClient,
    private readonly bot: Bot<BotContext>,
    private readonly env: Env,
  ) {}

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async check(): Promise<void> {
    try {
      const { data: settings } = await this.db
        .from('settings')
        .select('upstream_warn_cents,upstream_floor_cents,purchases_enabled')
        .single();

      if (!settings) return;

      const s = settings as { upstream_warn_cents: number; upstream_floor_cents: number; purchases_enabled: boolean };
      const bal = await this.pva.getBalance().catch(() => null);
      if (!bal) return;

      const cents = bal.cents;

      if (cents < s.upstream_floor_cents) {
        if (!this.floorReached) {
          this.floorReached = true;
          await this.db.from('settings').update({ purchases_enabled: false }).eq('id', true);
          await this.dmAdmins(
            `🛑 <b>PURCHASES PAUSED</b>\nUpstream balance dropped to <b>${formatCents(cents)}</b> — below the floor threshold (${formatCents(s.upstream_floor_cents)}).\nPurchases are now disabled. Please top up your PVADeals account.`,
          );
        }
      } else {
        if (this.floorReached) {
          this.floorReached = false;
          this.warnSent = false;
          if (!s.purchases_enabled) {
            await this.db.from('settings').update({ purchases_enabled: true }).eq('id', true);
            await this.dmAdmins(`✅ <b>Purchases re-enabled</b>\nBalance recovered to ${formatCents(cents)}.`);
          }
        }
        if (cents < s.upstream_warn_cents && !this.warnSent) {
          this.warnSent = true;
          await this.dmAdmins(
            `⚠️ <b>Low upstream balance</b>\nBalance is <b>${formatCents(cents)}</b> — below warn threshold (${formatCents(s.upstream_warn_cents)}).\nPlease top up your PVADeals account.`,
          );
        }
        if (cents >= s.upstream_warn_cents) this.warnSent = false;
      }
    } catch (e) {
      console.error('[balance-watch]', e instanceof Error ? e.message : e);
    }
  }

  private async dmAdmins(text: string): Promise<void> {
    for (const adminId of this.env.ADMIN_TELEGRAM_IDS) {
      await this.bot.api.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => undefined);
    }
  }
}
