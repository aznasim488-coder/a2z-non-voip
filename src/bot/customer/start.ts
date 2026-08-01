import type { BotContext } from '../middleware.js';
import { mainMenuKb } from '../ui/keyboards.js';
import { balanceLine } from '../ui/format.js';
import { getBalanceCents } from '../../domain/wallet.js';

export async function handleStart(ctx: BotContext): Promise<void> {
  const name = ctx.user.first_name;
  const balance = await getBalanceCents(ctx.db, ctx.user.telegram_id);

  await ctx.reply(
    `👋 Welcome, <b>${name}</b>!\n\n` +
    `I'm your non-VoIP SMS number bot. Buy 20-minute or long-term (3–30 day) ` +
    `numbers for OTP verification.\n\n` +
    `${balanceLine(balance)}\n\n` +
    `Use the buttons below to get started.`,
    {
      parse_mode: 'HTML',
      reply_markup: mainMenuKb(),
    },
  );
}
