import type { BotContext } from '../middleware.js';
import { getBalanceCents, creditWallet } from '../../domain/wallet.js';
import { formatCents } from '../../domain/money.js';
import { HR } from '../ui/format.js';
import { cb } from '../ui/codec.js';
import { InlineKeyboard } from 'grammy';
import { createInvoice, MIN_TOPUP_CENTS } from '../../payments/nowpayments.js';
import { verifyPayment } from '../../payments/binancepay.js';
import { binancePayEnabled, nowPaymentsEnabled } from '../../config/env.js';

// ─── Markers (used to detect ForceReply replies) ─────────────────────────────

export const TOPUP_PROMPT_MARKER    = 'Enter top-up amount in USD';
export const BINANCE_NAME_MARKER    = 'Enter your Binance display name';
export const BINANCE_AMOUNT_PREFIX  = 'Enter the USDT amount you sent — BinanceName:';

// ─── Wallet screen ────────────────────────────────────────────────────────────

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
    return `  ${icon} ${date} — ${formatCents(t.amount_cents)} [${t.method}]`;
  });

  const hasNowPayments = nowPaymentsEnabled(ctx.env);
  const hasBinance     = binancePayEnabled(ctx.env);
  const minUsd = (MIN_TOPUP_CENTS / 100).toFixed(2);

  const text =
    `💳 <b>Your Wallet</b>\n${HR}\n` +
    `Balance: <b>${formatCents(balance)}</b>\n\n` +
    (topupLines.length
      ? `<b>Recent top-ups:</b>\n${topupLines.join('\n')}\n\n`
      : '') +
    (hasNowPayments
      ? `💎 <b>Crypto (NOWPayments):</b>\n` +
        `• Min $${minUsd} · BTC, ETH, USDT, LTC, SOL...\n` +
        `• Auto-credited after confirmation\n\n`
      : '') +
    (hasBinance
      ? `💸 <b>Binance Pay (USDT):</b>\n` +
        `• Send USDT to Binance ID: <code>${ctx.env.BINANCE_ID}</code>\n` +
        `• Auto-verified within seconds\n\n`
      : '') +
    (!hasNowPayments && !hasBinance ? `Contact admin to add funds.` : `Tap a button below to top up.`);

  const kb = new InlineKeyboard();
  if (hasNowPayments) kb.text('💎 Crypto Top Up', cb('TOPUP_ENTER')).row();
  if (hasBinance)     kb.text('💸 Binance Pay',   cb('BINANCE_ENTER')).row();
  kb.text('🏠 Home', cb('HOME'));

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() =>
    ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }),
  );
}

// ─── NOWPayments flow ─────────────────────────────────────────────────────────

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

  const cleaned    = input.trim().replace(',', '.');
  const amountUsd  = parseFloat(cleaned);
  const minUsd     = MIN_TOPUP_CENTS / 100;

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

  if (amountUsd > 500) {
    await ctx.reply('❌ Maximum single top-up is $500. Contact admin for larger amounts.');
    return;
  }

  const amountCents = Math.round(amountUsd * 100);
  const ipnUrl      = `${ctx.env.PUBLIC_BASE_URL}/webhooks/nowpayments`;
  const loadingMsg  = await ctx.reply('⏳ Creating your payment link...').catch(() => undefined);

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

// ─── Binance Pay flow (3 steps) ────────────────────────────────────────────────

/** Step 1 — Show Binance ID card + ForceReply for Binance display name */
export async function handleBinanceEnter(ctx: BotContext): Promise<void> {
  if (!binancePayEnabled(ctx.env)) {
    await ctx.reply('❌ Binance Pay is not configured. Contact admin.');
    return;
  }

  const mid = ctx.env.BINANCE_ID!;

  await ctx.reply(
    `💸 <b>Binance Auto Payment</b>\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `🚨 <b>Binance ID:</b>\n<code>${mid}</code>\n\n` +
    `💱 <b>USDT only</b> – don't send any other coin\n\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `📌 <b>Steps:</b>\n` +
    `1️⃣ Send USDT to the Binance ID above
` +
    `2️⃣ Enter your Binance <b>display name</b> below
` +
    `   <i>(Your full name shown in Binance profile — NOT username/ID)</i>
` +
    `3️⃣ Enter the amount when asked

` +
    `⚠️ <b>Important:</b>\n` +
    `✅ USDT → Automatic recharge in seconds\n` +
    `❌ Other coins → Manual processing via admin\n\n` +
    `🤖 24/7 fully automated system\n` +
    `💵 Minimum: <b>$3.00 USDT</b>\n\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `👇 <b>${BINANCE_NAME_MARKER}:</b>
` +
    `<i>Enter the name shown on your Binance profile (e.g. "John Doe")</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: 'Your Binance display name (e.g. John Doe)',
      },
    },
  );
}

/** Step 2 — User replied with their Binance name → ask for amount */
export async function handleBinanceNameReply(ctx: BotContext, name: string): Promise<void> {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length < 2) {
    await ctx.reply('❌ Please enter your Binance display name (at least 2 characters).');
    return;
  }

  // Encode name in the marker so step 3 can read it without a session store
  await ctx.reply(
    `✅ Name recorded: <b>${trimmedName}</b>\n\n` +
    `Now enter the <b>exact USDT amount</b> you sent:\n` +
    `<b>${BINANCE_AMOUNT_PREFIX}${trimmedName}</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: 'Amount in USDT e.g. 10',
      },
    },
  );
}

/** Step 3 — User replied with amount → verify via API → credit wallet */
export async function handleBinanceAmountReply(
  ctx: BotContext,
  input: string,
  senderName: string,
): Promise<void> {
  if (!binancePayEnabled(ctx.env)) {
    await ctx.reply('❌ Binance Pay is not configured. Contact admin.');
    return;
  }

  const amountUsdt = parseFloat(input.trim().replace(',', '.'));

  if (isNaN(amountUsdt) || amountUsdt <= 0) {
    await ctx.reply(
      `❌ Invalid amount. Enter a number like <code>10</code> or <code>7.50</code>.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (amountUsdt < 3) {
    await ctx.reply('❌ Minimum Binance Pay top-up is <b>$3.00 USDT</b>.', { parse_mode: 'HTML' });
    return;
  }

  if (amountUsdt > 1000) {
    await ctx.reply('❌ Maximum single top-up is $1000. Contact admin for larger amounts.');
    return;
  }

  const loadingMsg = await ctx.reply('🔍 Verifying your payment...').catch(() => undefined);

  const config = {
    apiKey:    ctx.env.BINANCE_API_KEY!,
    secretKey: ctx.env.BINANCE_API_SECRET!,
    binanceId: ctx.env.BINANCE_ID!,
  };

  const result = await verifyPayment(config, senderName, amountUsdt);

  if (loadingMsg) {
    await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => undefined);
  }

  if (!result.matched) {
    await ctx.reply(
      `❌ <b>Payment not found</b>\n${HR}\n` +
      `We couldn't find a USDT payment of <b>$${amountUsdt.toFixed(2)}</b> ` +
      `from Binance name <b>${senderName}</b> in the last 45 minutes.\n\n` +
      `<b>Please check:</b>\n` +
      `• Did you send <b>USDT</b> (not BNB or other coins)?\n` +
      `• Is your display name exactly: <code>${senderName}</code>?\n` +
      `• Did you send to Binance ID <code>${config.binanceId}</code>?\n\n` +
      `If you're sure you sent it, wait a moment and try again or contact admin.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const tx = result.transaction!;
  const amountCents = Math.round(parseFloat(tx.amount) * 100);
  const idempotencyKey = `binance_pay_${tx.transactionId}`;

  // Idempotency: check if this transaction was already credited
  const { data: existing } = await ctx.db
    .from('ledger_entries')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existing) {
    await ctx.reply(
      `⚠️ This payment has already been credited to your account.\n` +
      `Transaction ID: <code>${tx.transactionId}</code>`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Credit the wallet
  try {
    await creditWallet(ctx.db, {
      userId: ctx.user.id,
      amountCents,
      kind: 'topup',
      idempotencyKey,
      note: `Binance Pay USDT — sender: ${senderName} — tx: ${tx.transactionId}`,
    });

    // Record in topups table for history
    await ctx.db.from('topups').insert({
      user_id:     ctx.user.id,
      amount_cents: amountCents,
      method:      'binancepay' as any,
      status:      'confirmed',
      external_id: tx.transactionId,
      note:        `Binance name: ${senderName}`,
    } as any);

    const newBalance = await getBalanceCents(ctx.db, ctx.user.telegram_id);
    const kb = new InlineKeyboard()
      .text('💳 Wallet', cb('TOPUP'))
      .text('📲 Buy Number', cb('SVC_LIST', 1)).row()
      .text('🏠 Home', cb('HOME'));

    await ctx.reply(
      `✅ <b>Payment Verified!</b>\n${HR}\n` +
      `💸 USDT amount: <b>$${parseFloat(tx.amount).toFixed(2)}</b>\n` +
      `💳 New balance: <b>${formatCents(newBalance)}</b>\n\n` +
      `Your wallet has been credited automatically! 🎉`,
      { parse_mode: 'HTML', reply_markup: kb },
    );

    console.log(`[binance-pay] credited ${ctx.user.id} $${amountUsdt} tx:${tx.transactionId}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[binance-pay] credit failed:', msg);
    await ctx.reply(
      `❌ Verification succeeded but crediting failed.\n` +
      `Transaction ID: <code>${tx.transactionId}</code>\n` +
      `Please contact admin with this ID.`,
      { parse_mode: 'HTML' },
    );
  }
}
