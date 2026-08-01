import type { BotContext } from '../middleware.js';
import { getBalanceCents } from '../../domain/wallet.js';
import { formatCents } from '../../domain/money.js';
import { HR } from '../ui/format.js';
import { cb } from '../ui/codec.js';
import { InlineKeyboard } from 'grammy';
import { createInvoice, MIN_TOPUP_CENTS } from '../../payments/nowpayments.js';

// Preset top-up amounts in USD (all ≥ minimum $3)
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
  const minUsd = (MIN_TOPUP_CENTS / 100).toFixed(2);

  const text =
    `💳 <b>Your Wallet</b>\n${HR}\n` +
    `Balance: <b>${formatCents(balance)}</b>\n\n` +
    (topupLines.length
      ? `<b>Recent top-ups:</b>\n${topupLines.join('\n')}\n\n`
      : '') +
    `<b>Add Funds:</b>\n` +
    (hasNowPayments
      ? `Minimum: <b>$${minUsd}</b> — Pay with <b>any crypto</b> (BTC, ETH, USDT, LTC...)\n` +
        `Select an amount below — you'll choose your coin on the payment page.\n` +
        `Wallet credited automatically after confirmation. ✅`
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

/** Called when user taps a $X amount button — creates invoice and sends payment link */
export async function handleTopupAmount(ctx: BotContext, amountUsd: number): Promise<void> {
  const apiKey = ctx.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    await ctx.reply('❌ Crypto payments not configured. Contact admin.');
    return;
  }

  // Guard minimum
  const minUsd = MIN_TOPUP_CENTS / 100;
  if (amountUsd < minUsd) {
    await ctx.reply(`❌ Minimum top-up is $${minUsd.toFixed(2)}.`);
    return;
  }

  const amountCents = Math.round(amountUsd * 100);
  const ipnUrl = `${ctx.env.PUBLIC_BASE_URL}/webhooks/nowpayments`;

  await ctx.reply('⏳ Creating payment link...').catch(() => undefined);

  try {
    const invoice = await createInvoice({
      apiKey,
      amountUsd,
      userId: ctx.user.id,
      amountCents,
      ipnCallbackUrl: ipnUrl,
    });

    const kb = new InlineKeyboard()
      .url(`💳 Pay $${amountUsd.toFixed(2)} — Choose Your Crypto`, invoice.invoice_url).row()
      .text('🔙 Top-up Menu', cb('TOPUP')).row()
      .text('🏠 Home', cb('HOME'));

    await ctx.reply(
      `💎 <b>Payment — $${amountUsd.toFixed(2)}</b>\n${HR}\n` +
      `Tap the button below to pay.\n` +
      `You can choose <b>any crypto</b>:\n` +
      `BTC · ETH · USDT · LTC · BNB · SOL · DOGE · and more\n\n` +
      `✅ Your wallet will be credited <b>automatically</b> after confirmation.\n` +
      `⏱️ Usually confirms in <b>1–15 minutes</b> depending on coin.\n\n` +
      `<i>Invoice ID: ${invoice.id}</i>`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[wallet] NOWPayments invoice error', msg);
    await ctx.reply(
      '❌ Could not create payment link. Please try again in a moment.\n' +
      'If this keeps happening, contact admin.',
    );
  }
}
