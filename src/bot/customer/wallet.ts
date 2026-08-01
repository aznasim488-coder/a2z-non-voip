import type { BotContext } from '../middleware.js';
import { getBalanceCents } from '../../domain/wallet.js';
import { formatCents } from '../../domain/money.js';
import { HR } from '../ui/format.js';
import { cb } from '../ui/codec.js';
import { InlineKeyboard } from 'grammy';
import { createInvoice, MIN_TOPUP_CENTS } from '../../payments/nowpayments.js';

// Marker text so message handler can identify replies to this prompt
export const TOPUP_PROMPT_MARKER = 'Enter top-up amount in USD';

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
    (hasNowPayments
      ? `<b>Add Funds via Crypto:</b>\n` +
        `• Minimum: <b>$${minUsd}</b>\n` +
        `• Pay with any coin: BTC, ETH, USDT, LTC, SOL...\n` +
        `• Wallet credited <b>automatically</b> after confirmation\n\n` +
        `Tap <b>💎 Top Up</b> and enter your amount.`
      : `Contact admin to add funds manually.`);

  const kb = new InlineKeyboard();
  if (hasNowPayments) {
    kb.text('💎 Top Up', cb('TOPUP_ENTER')).row();
  }
  kb.text('🏠 Home', cb('HOME'));

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() =>
    ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }),
  );
}

/** Send ForceReply prompt asking user to type their top-up amount */
export async function handleTopupEnter(ctx: BotContext): Promise<void> {
  const min = (MIN_TOPUP_CENTS / 100).toFixed(2);
  await ctx.reply(
    `💎 <b>${TOPUP_PROMPT_MARKER}</b>\n${HR}\n` +
    `Minimum: <b>$${min}</b>\n` +
    `You can enter any amount e.g. <code>5</code>, <code>7.50</code>, <code>20</code>\n\n` +
    `Type your amount below and send:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: `Min $${min} — e.g. 10`,
      },
    },
  );
}

/** Called after user types a custom amount in reply to the ForceReply prompt */
export async function handleTopupCustomAmount(ctx: BotContext, input: string): Promise<void> {
  const apiKey = ctx.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    await ctx.reply('❌ Crypto payments not configured. Contact admin.');
    return;
  }

  // Parse the input — accept comma or dot decimal separator
  const cleaned = input.trim().replace(',', '.');
  const amountUsd = parseFloat(cleaned);
  const minUsd = MIN_TOPUP_CENTS / 100;

  if (isNaN(amountUsd) || amountUsd <= 0) {
    await ctx.reply(
      `❌ Invalid amount. Please enter a number like <code>10</code> or <code>7.50</code>.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (amountUsd < minUsd) {
    await ctx.reply(
      `❌ Minimum top-up is <b>$${minUsd.toFixed(2)}</b>.\n` +
      `You entered <b>$${amountUsd.toFixed(2)}</b> — please try again.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Cap at $500 to avoid accidents
  if (amountUsd > 500) {
    await ctx.reply('❌ Maximum single top-up is $500. Contact admin for larger amounts.');
    return;
  }

  const amountCents = Math.round(amountUsd * 100);
  const ipnUrl = `${ctx.env.PUBLIC_BASE_URL}/webhooks/nowpayments`;

  const loadingMsg = await ctx.reply('⏳ Creating your payment link...').catch(() => undefined);

  try {
    const invoice = await createInvoice({
      apiKey,
      amountUsd,
      userId: ctx.user.id,
      amountCents,
      ipnCallbackUrl: ipnUrl,
    });

    const kb = new InlineKeyboard()
      .url(`💳 Pay $${amountUsd.toFixed(2)} — Pick Your Crypto`, invoice.invoice_url).row()
      .text('💎 Top Up Again', cb('TOPUP_ENTER')).row()
      .text('💳 Wallet', cb('TOPUP')).text('🏠 Home', cb('HOME'));

    // Delete the loading message
    if (loadingMsg) {
      await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => undefined);
    }

    await ctx.reply(
      `💎 <b>Payment Link — $${amountUsd.toFixed(2)}</b>\n${HR}\n` +
      `Tap below to choose your cryptocurrency and pay:\n` +
      `<i>BTC · ETH · USDT · LTC · BNB · SOL · DOGE · TRX · and more</i>\n\n` +
      `✅ Wallet credited <b>automatically</b> after confirmation\n` +
      `⏱ Typically <b>1–15 minutes</b> depending on coin\n\n` +
      `Invoice: <code>${invoice.id}</code>`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[wallet] NOWPayments invoice error', msg);
    if (loadingMsg) {
      await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => undefined);
    }
    await ctx.reply(
      '❌ Could not create payment link. Please try again.\n' +
      'If this keeps happening, contact admin.',
    );
  }
}
