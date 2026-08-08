import type { BotContext } from '../middleware.js';
import { adminMenuKb } from '../ui/keyboards.js';
import { esc, HR } from '../ui/format.js';
import { isAdmin } from '../../config/env.js';

function formatCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

/** /admin command — shows admin dashboard with live stats. */
export async function handleAdminMenu(ctx: BotContext): Promise<void> {
  if (!isAdmin(ctx.env, ctx.user?.telegram_id)) {
    await ctx.reply('❌ Not authorized.');
    return;
  }

  const [balRes, userRes, orderRes, settingsRes] = await Promise.all([
    ctx.pva.getBalance().catch(() => null),
    ctx.db.from('profiles').select('id', { count: 'exact', head: true }),
    ctx.db
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - 86_400_000).toISOString()),
    ctx.db.from('settings').select('min_topup_cents').single(),
  ]);

  const upstreamBal = balRes ? formatCents(balRes.cents) : 'unknown';
  const userCount = userRes.count ?? '?';
  const ordersToday = orderRes.count ?? '?';
  const minTopup = formatCents((settingsRes.data as any)?.min_topup_cents ?? 300);

  const text =
    `🛠 <b>Admin Panel</b>\n${HR}\n` +
    `Upstream balance: <b>${upstreamBal}</b>\n` +
    `Total users: <b>${userCount}</b>\n` +
    `Orders today: <b>${ordersToday}</b>\n` +
    `Min top-up: <b>${minTopup}</b>\n` +
    `Breaker: <b>${ctx.pva.breaker.state}</b>\n` +
    `Upstream health: <b>${ctx.pva.health.healthy ? '✅ OK' : '❌ DOWN'}</b>\n\n` +
    `<b>Commands:</b>\n` +
    `/setplan STR 0.18 — set plan flat price\n` +
    `/setreuse 0.80 — set reuse price\n` +
    `/setglobal x2.00 — set global multiplier\n` +
    `/setmintopup 3.00 — set min top-up\n` +
    `/credit 123456789 5.00 reason — add credit\n` +
    `/ban 123456789 | /unban 123456789\n` +
    `/exportcsv — download price CSV\n` +
    `/broadcast &lt;text&gt; — DM all users\n` +
    `/users — list users`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: adminMenuKb() });
}

/** /status — detailed upstream system status. */
export async function handleAdminStatus(ctx: BotContext): Promise<void> {
  if (!isAdmin(ctx.env, ctx.user?.telegram_id)) return;

  const bal = await ctx.pva.getBalance().catch(() => null);
  const { data: settings } = await ctx.db
    .from('settings')
    .select('upstream_warn_cents,upstream_floor_cents,purchases_enabled')
    .single();

  const s = settings as { upstream_warn_cents: number; upstream_floor_cents: number; purchases_enabled: boolean } | null;
  const balCents = bal?.cents ?? 0;
  const warnOk = balCents >= (s?.upstream_warn_cents ?? 1000);
  const floorOk = balCents >= (s?.upstream_floor_cents ?? 100);

  await ctx.reply(
    `📡 <b>Upstream Status</b>\n${HR}\n` +
    `Health: <b>${ctx.pva.health.healthy ? '✅ OK' : '❌ DOWN'}</b>\n` +
    `Breaker: <b>${ctx.pva.breaker.state}</b>\n` +
    (ctx.pva.breaker.state !== 'closed' ? `  Recovers in: ${Math.ceil(ctx.pva.breaker.remainingMs / 1000)}s\n` : '') +
    `Balance: <b>${formatCents(balCents)}</b>\n` +
    `  Warn (${formatCents(s?.upstream_warn_cents ?? 1000)}): ${warnOk ? '✅' : '⚠️ LOW'}\n` +
    `  Floor (${formatCents(s?.upstream_floor_cents ?? 100)}): ${floorOk ? '✅' : '🛑 BELOW'}\n` +
    `Purchases: <b>${s?.purchases_enabled ? '✅ enabled' : '❌ disabled'}</b>`,
    { parse_mode: 'HTML' },
  );
}

/** /broadcast <message> — send announcement to all non-banned users (~25/s). */

// Deduplicate by Telegram message_id — the same /broadcast message always
// has the same ID, so retried webhook deliveries are safely ignored even
// after the first run completes and the in-flight flag is reset.
const _processedBroadcastIds = new Set<number>();
let _broadcastRunning = false;

export async function handleBroadcast(ctx: BotContext, text: string): Promise<void> {
  if (!isAdmin(ctx.env, ctx.user?.telegram_id)) return;
  if (!text.trim()) { await ctx.reply('❌ Provide a message: /broadcast <text>'); return; }

  // Reject if this exact message was already processed (webhook retry)
  const msgId = ctx.message?.message_id;
  if (msgId !== undefined && _processedBroadcastIds.has(msgId)) {
    return; // silently drop — already handled
  }

  // Reject if another broadcast is currently in progress
  if (_broadcastRunning) {
    await ctx.reply('⚠️ A broadcast is already in progress. Please wait for it to finish.');
    return;
  }

  // Mark this message as handled immediately (before any awaits)
  if (msgId !== undefined) {
    _processedBroadcastIds.add(msgId);
    // Clean up old IDs after 10 minutes to avoid unbounded growth
    setTimeout(() => _processedBroadcastIds.delete(msgId), 10 * 60_000);
  }

  _broadcastRunning = true;

  try {
    const { data: profiles } = await ctx.db
      .from('profiles')
      .select('telegram_id')
      .eq('is_banned', false);

    const users = (profiles ?? []) as { telegram_id: number }[];
    await ctx.reply(`📢 Sending to ${users.length} users...`);

    let sent = 0, failed = 0;
    for (let i = 0; i < users.length; i++) {
      if (i > 0 && i % 25 === 0) await new Promise((r) => setTimeout(r, 1000));
      try {
        await ctx.api.sendMessage(
          users[i]!.telegram_id,
          `📢 <b>Announcement</b>\n\n${esc(text)}`,
          { parse_mode: 'HTML' },
        );
        sent++;
      } catch { failed++; }
    }

    await ctx.reply(`✅ Broadcast done: ${sent} sent, ${failed} failed.`);
  } finally {
    _broadcastRunning = false;
  }
}
