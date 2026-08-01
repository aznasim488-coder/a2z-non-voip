import type { BotContext } from '../middleware.js';
import { getBalanceCents } from '../../domain/wallet.js';
import { formatCents } from '../../domain/money.js';
import { HR } from '../ui/format.js';
import { cb } from '../ui/codec.js';
import { InlineKeyboard } from 'grammy';
import { createPayment, MIN_TOPUP_CENTS } from '../../payments/nowpayments.js';

// Preset top-up amounts in USD (minimum $3)
const TOPUP_AMOUNTS = [3, 5, 10, 20, 50];

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
    const icon = t.status === 'confirmed' ? '✅' : t.status === 'pending' ? '⏳' : '❌';
    return `  ${icon} ${date} — ${formatCents(t.amount_cents)} [${t.status}]`;
  });

  const hasNowPayments = Boolean(ctx.env.NOWPAYMENTS_API_KEY);

  const text =
    `💳 <b>Your Wallet</b>\n${HR}\n` +
    `Balance: <b>${formatCents(balance)}</b>\n\n` +
    (topupLines.length
      ? `<b>Recent top-ups:</b>\n${topupLines.join('\n')}\n\n`
      : '') +
    `<b>Add Funds via Crypto (USDT TRC20):</b>\n` +
    `Minimum deposit: <b>$${(MIN_TOPUP_CENTS / 100).toFixed(2)}</b>\n` +
    `Funds credited automatically after payment confirmation.\n\n` +
    (hasNowPayments
      ? `Choose an amount below 👇`
      : `Contact admin to add funds manually.`);

  const kb = new InlineKeyboard();

  if (hasNowPayments) {
    // Two amounts per row
    for (let i = 0; i < TOPUP_AMOUNTS.length; i += 2) {
      const a = TOPUP_AMOUNTS[i]!;
      const b = TOPUP_AMOUNTS[i + 1];
      kb.text(`💎 $${a}`, cb('TOPUP_AMT', a));
      if (b) kb.text(`💎 $${b}`, cb('TOPUP_AMT', b));
      kb.row();
    }
  }

  kb.text('🏠 Home', cb('HOME'));

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() =>
    ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }),
  );
}

/** Called when user taps a top-up amount button */
export async function handleTopupAmount(ctx: BotContext, amountUsd: number): Promise<void> {
  const apiKey = ctx.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    await ctx.reply('❌ Crypto payments not configured. Contact admin.');
    return;
  }

  // Enforce minimum
  const minUsd = MIN_TOPUP_CENTS / 100;
  if (amountUsd < minUsd) {
    await ctx.reply(`❌ Minimum top-up is $${minUsd.toFixed(2)}.`);
    return;
  }

  const ipnUrl = `${ctx.env.PUBLIC_BASE_URL}/webhooks/nowpayments`;

  await ctx.reply('⏳ Creating payment address...').catch(() => undefined);

  try {
    const payment = await createPayment({
      apiKey,
      amountUsd,
      userId: ctx.user.id,
      ipnCallbackUrl: ipnUrl,
    });

    const kb = new InlineKeyboard()
      .text('🔄 Check Another Amount', cb('TOPUP')).row()
      .text('🏠 Home', cb('HOME'));

    await ctx.reply(
      `💎 <b>Payment Created — $${amountUsd.toFixed(2)}</b>\n${HR}\n` +
      `Send exactly:\n` +
      `<b>${payment.pay_amount} USDT (TRC20)</b>\n\n` +
      `To this address:\n` +
      `<code>${payment.pay_address}</code>\n\n` +
      `⚠️ <b>Important:</b>\n` +
      `• Send <b>TRC20 USDT only</b> (not ERC20 or BEP20)\n` +
      `• Send the exact amount shown above\n` +
      `• Your wallet will be credited automatically\n` +
      `• Usually confirms in <b>1-5 minutes</b>\n\n` +
      `Payment ID: <code>${payment.payment_id}</code>`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[wallet] NOWPayments error', msg);
    await ctx.reply('❌ Could not create payment. Please try again or contact admin.');
  }
}
