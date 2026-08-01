import type { BotContext } from '../middleware.js';
import { formatCents } from '../../domain/money.js';
import { creditWallet } from '../../domain/wallet.js';
import { esc, HR } from '../ui/format.js';

/** /users [page] — list all users with balance. */
export async function handleAdminUsers(ctx: BotContext, page = 1): Promise<void> {
  const PAGE = 10;
  const offset = (page - 1) * PAGE;

  const { data, error } = await ctx.db
    .from('profiles')
    .select('id,telegram_id,username,first_name,is_banned,wallets(balance_cents)')
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE);

  if (error) { await ctx.reply('❌ DB error: ' + esc(error.message)); return; }

  const rows = data ?? [];
  if (rows.length === 0) { await ctx.reply('No users yet.'); return; }

  const lines = rows.slice(0, PAGE).map((u: {
    telegram_id: number;
    username?: string;
    first_name: string;
    is_banned: boolean;
    wallets?: { balance_cents: number }[];
  }, i: number) => {
    const name = u.username ? `@${u.username}` : esc(u.first_name);
    const bal = formatCents(u.wallets?.[0]?.balance_cents ?? 0);
    const banned = u.is_banned ? ' 🔴' : '';
    return `${offset + i + 1}. ${name} [${u.telegram_id}] — ${bal}${banned}`;
  });

  const hasMore = rows.length > PAGE;
  const { InlineKeyboard } = await import('grammy');
  const kb = new InlineKeyboard();
  if (page > 1) kb.text('◀ Prev', `ADM_USERS:${page - 1}`);
  if (hasMore) kb.text('Next ▶', `ADM_USERS:${page + 1}`);
  if (page > 1 || hasMore) kb.row();
  kb.text('🔙 Admin', 'ADM_MAIN');

  await ctx.reply(
    `👥 <b>Users</b> (page ${page})\n${HR}\n` + lines.join('\n') +
    `\n\n<code>/credit &lt;telegram_id&gt; &lt;amount&gt; &lt;note&gt;</code> — add credit\n` +
    `<code>/ban &lt;telegram_id&gt;</code> | <code>/unban &lt;telegram_id&gt;</code>`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

/**
 * /credit <telegram_id> <amount> <note...> — manually add credit to a user.
 * Always requires a note — omitting it is a config error, not just bad UX.
 */
export async function handleAdminCredit(
  ctx: BotContext,
  telegramId: number,
  amountDollars: number,
  note: string,
): Promise<void> {
  if (!note.trim()) {
    await ctx.reply('❌ A note is required for manual credits.');
    return;
  }

  // Look up profile
  const { data: profile } = await ctx.db
    .from('profiles')
    .select('id,first_name,username')
    .eq('telegram_id', telegramId)
    .single();

  if (!profile) {
    await ctx.reply(`❌ User ${telegramId} not found.`);
    return;
  }

  const amountCents = Math.round(amountDollars * 100);
  const idempotencyKey = `admin_credit_${ctx.user.id}_${telegramId}_${Date.now()}`;

  try {
    const newBalance = await creditWallet(ctx.db, {
      userId: profile.id as string,
      amountCents,
      kind: 'admin_credit',
      idempotencyKey,
      note: `Admin: ${note}`,
      createdBy: ctx.user.id,
    });

    const displayName = (profile.username as string)
      ? `@${profile.username}`
      : esc(profile.first_name as string);

    await ctx.reply(
      `✅ Credited <b>${formatCents(amountCents)}</b> to ${displayName} [${telegramId}]\n` +
      `New balance: <b>${formatCents(newBalance)}</b>\n` +
      `Note: ${esc(note)}`,
      { parse_mode: 'HTML' },
    );

    // Notify the user
    await ctx.api.sendMessage(
      telegramId,
      `💳 <b>Your balance has been topped up!</b>\n` +
      `Amount: <b>${formatCents(amountCents)}</b>\n` +
      `New balance: <b>${formatCents(newBalance)}</b>`,
      { parse_mode: 'HTML' },
    ).catch(() => undefined); // Don't fail if user blocked the bot
  } catch (e) {
    await ctx.reply('❌ Credit failed: ' + esc(e instanceof Error ? e.message : 'unknown'));
  }
}

/** /ban <telegram_id> / /unban <telegram_id> */
export async function handleAdminBan(ctx: BotContext, telegramId: number, ban: boolean): Promise<void> {
  const { error } = await ctx.db
    .from('profiles')
    .update({ is_banned: ban })
    .eq('telegram_id', telegramId);

  if (error) { await ctx.reply('❌ ' + esc(error.message)); return; }
  await ctx.reply(`${ban ? '🔴 Banned' : '🟢 Unbanned'} user ${telegramId}.`);
}
