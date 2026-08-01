import type { BotContext } from '../middleware.js';
import { getBalanceCents } from '../../domain/wallet.js';
import { formatCents } from '../../domain/money.js';
import { esc, HR } from '../ui/format.js';
import { InlineKeyboard } from 'grammy';

export async function handleWallet(ctx: BotContext): Promise<void> {
  const balance = await getBalanceCents(ctx.db, ctx.user.telegram_id);

  const { data: recent } = await ctx.db
    .from('topups')
    .select('amount_cents,status,created_at,method')
    .eq('user_id', ctx.user.id)
    .order('created_at', { ascending: false })
    .limit(5);

  const topupLines = (recent ?? []).map((t: {
    amount_cents: number;
    status: string;
    created_at: string;
    method: string;
  }) => {
    const date = new Date(t.created_at).toLocaleDateString();
    return `  ${date} — ${formatCents(t.amount_cents)} [${t.status}] via ${t.method}`;
  });

  const text =
    `💳 <b>Your Wallet</b>\n${HR}\n` +
    `Balance: <b>${formatCents(balance)}</b>\n\n` +
    (topupLines.length
      ? `<b>Recent top-ups:</b>\n${topupLines.join('\n')}`
      : `No top-ups yet.`) +
    `\n\n<b>To add funds:</b>\n` +
    `Contact the admin or use the crypto deposit option below.`;

  const kb = new InlineKeyboard()
    .text('💎 Crypto Top-up', 'TOPUP_CRYPTO').row()
    .text('🔙 Main Menu', 'NOOP');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() =>
    ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }),
  );
}
