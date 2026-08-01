import type { BotContext } from '../middleware.js';
import { getBalanceCents, creditWallet } from '../../domain/wallet.js';
import { formatCents } from '../../domain/money.js';
import { HR } from '../ui/format.js';
import { cb } from '../ui/codec.js';
import { InlineKeyboard } from 'grammy';
import { createInvoice, MIN_TOPUP_CENTS } from '../../payments/nowpayments.js';
import { verifyPayment } from '../../payments/binancepay.js';
import { tkToCents } from '../../payments/bkash.js';
import { binancePayEnabled, nowPaymentsEnabled } from '../../config/env.js';
import { SUPPORT_URL } from '../ui/keyboards.js';

// ─── Markers (used to detect ForceReply replies) ────────────────────────────────────────────

export const TOPUP_PROMPT_MARKER    = 'Enter top-up amount in USD';
export const BINANCE_NAME_MARKER    = 'Enter your Binance display name';
export const BINANCE_AMOUNT_PREFIX  = 'Enter the USDT amount you sent — BinanceName:';
export const BKASH_TRXID_MARKER     = 'Paste your bKash Transaction ID';
export const BKASH_AMOUNT_PREFIX    = 'Enter the amount in TK — BkashTrx:';
export const NAGAD_TRXID_MARKER     = 'Paste your Nagad Transaction ID';
export const NAGAD_AMOUNT_PREFIX    = 'Enter the amount in TK — NagadTrx:';

// ─── Helper: fetch payment settings from DB ───────────────────────────────

type PaySettings = {
  bkash_number: string;
  bkash_rate_tk: number;
  bkash_min_tk: number;
  bkash_enabled: boolean;
  nagad_number: string;
  nagad_rate_tk: number;
  nagad_min_tk: number;
  nagad_enabled: boolean;
};

async function getPaySettings(db: BotContext['db']): Promise<PaySettings> {
  const { data } = await db.from('settings').select(
    'bkash_number,bkash_rate_tk,bkash_min_tk,bkash_enabled,nagad_number,nagad_rate_tk,nagad_min_tk,nagad_enabled'
  ).maybeSingle();
  const d = data as any;
  return {
    bkash_number:   d?.bkash_number   ?? '01799424191',
    bkash_rate_tk:  d?.bkash_rate_tk  ?? 130,
    bkash_min_tk:   d?.bkash_min_tk   ?? 390,
    bkash_enabled:  d?.bkash_enabled  ?? true,
    nagad_number:   d?.nagad_number   ?? '',
    nagad_rate_tk:  d?.nagad_rate_tk  ?? 130,
    nagad_min_tk:   d?.nagad_min_tk   ?? 390,
    nagad_enabled:  d?.nagad_enabled  ?? false,
  };
}

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
  const pay            = await getPaySettings(ctx.db);
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
    (pay.bkash_enabled && pay.bkash_number
      ? `💹 <b>bKash (BDT):</b>\n` +
        `• Rate: ${pay.bkash_rate_tk} TK = $1 USD • Min ${pay.bkash_min_tk} TK\n\n`
      : '') +
    (pay.nagad_enabled && pay.nagad_number
      ? `💰 <b>Nagad (BDT):</b>\n` +
        `• Rate: ${pay.nagad_rate_tk} TK = $1 USD • Min ${pay.nagad_min_tk} TK\n\n`
      : '') +
    (!hasNowPayments && !hasBinance && !pay.bkash_enabled && !pay.nagad_enabled
      ? `Contact admin to add funds.`
      : `Tap a button below to top up.`);

  const kb = new InlineKeyboard();
  if (hasNowPayments)                          kb.text('💎 Crypto Top Up', cb('TOPUP_ENTER')).row();
  if (hasBinance)                              kb.text('💸 Binance Pay',   cb('BINANCE_ENTER')).row();
  if (pay.bkash_enabled && pay.bkash_number)   kb.text('💹 bKash',          cb('BKASH_ENTER')).row();
  if (pay.nagad_enabled && pay.nagad_number)   kb.text('💰 Nagad',          cb('NAGAD_ENTER')).row();
  kb.url('💬 Contact Support', SUPPORT_URL).row();
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
    const kb = new InlineKeyboard()
      .url('💬 Contact Support', SUPPORT_URL).row()
      .text('🏠 Home', cb('HOME'));
    await ctx.reply(
      `❌ <b>Payment not found</b>\n${HR}\n` +
      `We couldn't find a USDT payment of <b>$${amountUsdt.toFixed(2)}</b> ` +
      `from Binance name <b>${senderName}</b> in the last 45 minutes.\n\n` +
      `<b>Please check:</b>\n` +
      `• Did you send <b>USDT</b> (not BNB or other coins)?\n` +
      `• Is your Binance display name exactly: <code>${senderName}</code>?\n` +
      `• Did you send to Binance ID <code>${config.binanceId}</code>?\n\n` +
      `If you're sure you sent it, wait a moment and try again.\n` +
      `Or tap <b>Contact Support</b> below.`,
      { parse_mode: 'HTML', reply_markup: kb },
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

// ─── bKash flow (3 steps) ─────────────────────────────────────────────────────

/** Step 1 — Show bKash number + ForceReply for Transaction ID */
export async function handleBkashEnter(ctx: BotContext): Promise<void> {
  const pay = await getPaySettings(ctx.db);
  if (!pay.bkash_enabled || !pay.bkash_number) {
    await ctx.reply('❌ bKash is not configured. Contact admin.');
    return;
  }

  await ctx.reply(
    `💹 <b>bKash — BDT Payment</b>\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `⭕️ <b>Dollar Rate = ${pay.bkash_rate_tk} TK</b>\n\n` +
    `🟢 <b>Send Money এখানে:</b>\n` +
    `<code>${pay.bkash_number}</code>\n\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `📌 <b>Steps:</b>\n` +
    `1️⃣ এই নম্বরে Send Money করুন\n` +
    `2️⃣ Transaction ID এখানে paste করুন\n` +
    `3️⃣ Amount (TK) submit করুন\n\n` +
    `⏱ Admin verify করার পর wallet এ যোগ হবে\n\n` +
    `👇 <b>${BKASH_TRXID_MARKER}:</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, selective: true,
        input_field_placeholder: 'Transaction ID e.g. ABC1234XYZ' },
    },
  );
}

/** Step 2 — User replied with TrxID → ask for TK amount */
export async function handleBkashTrxReply(ctx: BotContext, trxId: string): Promise<void> {
  const cleaned = trxId.trim();
  if (!cleaned || cleaned.length < 4) {
    await ctx.reply('❌ Invalid Transaction ID. Please send the full TrxID from bKash.');
    return;
  }

  await ctx.reply(
    `✅ TrxID recorded: <code>${cleaned}</code>\n\n` +
    `এখন আপনি কত টাকা পাঠিয়েছেন সেটি লিখুন:\n` +
    `<b>${BKASH_AMOUNT_PREFIX}${cleaned}</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: 'Amount in TK e.g. 250',
      },
    },
  );
}

/** Step 3 — User replied with TK amount → save pending → notify admin */
export async function handleBkashAmountReply(
  ctx: BotContext,
  input: string,
  trxId: string,
): Promise<void> {
  const pay = await getPaySettings(ctx.db);
  if (!pay.bkash_enabled || !pay.bkash_number) {
    await ctx.reply('❌ bKash is not configured. Contact admin.');
    return;
  }

  const amountTk = parseFloat(input.trim().replace(',', '.'));
  const minTk    = pay.bkash_min_tk;
  const rateTk   = pay.bkash_rate_tk;

  if (isNaN(amountTk) || amountTk <= 0) {
    await ctx.reply(`❌ Invalid amount. Enter a number like <code>390</code>.`, { parse_mode: 'HTML' });
    return;
  }
  if (amountTk < minTk) {
    await ctx.reply(`❌ Minimum bKash top-up is <b>${minTk} TK</b>.`, { parse_mode: 'HTML' });
    return;
  }

  // Idempotency — prevent duplicate submissions for same TrxID
  const idempotencyKey = `bkash_${trxId}`;
  const { data: existing } = await ctx.db
    .from('ledger_entries')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existing) {
    await ctx.reply(
      `⚠️ এই TrxID আগেই submit করা হয়েছে।\nTrxID: <code>${trxId}</code>`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const amountCents = Math.round((amountTk / rateTk) * 100);
  const amountUsd   = (amountCents / 100).toFixed(2);

  // Save as pending topup
  await ctx.db.from('topups').insert({
    user_id:      ctx.user.id,
    amount_cents: amountCents,
    method:       'bkash' as any,
    status:       'pending',
    external_id:  trxId,
    note:         `${amountTk} TK @ ${rateTk} TK/$ — pending admin approval`,
  } as any);

  // Tell user it's pending
  await ctx.reply(
    `⏳ <b>bKash Payment Submitted!</b>\n${HR}\n` +
    `TrxID: <code>${trxId}</code>\n` +
    `Amount: <b>${amountTk} TK</b> = <b>$${amountUsd}</b>\n\n` +
    `Admin verify করছেন — সাধারণত কয়েক মিনিটের মধ্যে wallet এ যোগ হবে।\n` +
    `✅ Approved হলে notification পাবেন।`,
    { parse_mode: 'HTML' },
  );

  // Notify every admin with Approve / Reject inline buttons
  const userName = ctx.user.username ? `@${ctx.user.username}` : ctx.user.first_name;
  const adminText =
    `💹 <b>bKash Payment — Pending</b>\n${HR}\n` +
    `👤 User: ${userName} (<code>${ctx.user.telegram_id}</code>)\n` +
    `📋 TrxID: <code>${trxId}</code>\n` +
    `💵 Amount: <b>${amountTk} TK</b> → <b>$${amountUsd}</b>\n\n` +
    `Check your bKash app and tap below:`;

  const adminKb = new InlineKeyboard()
    .text(`✅ Approve $${amountUsd}`, cb('BK_APR', ctx.user.telegram_id, trxId, amountCents)).row()
    .text(`❌ Reject`,                cb('BK_REJ', ctx.user.telegram_id, trxId));

  for (const adminId of ctx.env.ADMIN_TELEGRAM_IDS) {
    await ctx.api.sendMessage(adminId, adminText, {
      parse_mode: 'HTML',
      reply_markup: adminKb,
    }).catch((e) => console.error(`[bkash] admin notify failed for ${adminId}:`, e));
  }

  console.log(`[bkash] pending trx=${trxId} user=${ctx.user.id} ${amountTk}TK`);
}

/** Admin tapped Approve — credit the wallet and notify user */
export async function handleBkashApprove(
  ctx: BotContext,
  userTelegramId: number,
  trxId: string,
  amountCents: number,
): Promise<void> {
  const idempotencyKey = `bkash_${trxId}`;

  // Check already credited
  const { data: existing } = await ctx.db
    .from('ledger_entries')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existing) {
    await ctx.editMessageText(`⚠️ Already credited. TrxID: <code>${trxId}</code>`, { parse_mode: 'HTML' });
    return;
  }

  // Get user record
  const { data: userRow } = await ctx.db
    .from('users')
    .select('id')
    .eq('telegram_id', userTelegramId)
    .maybeSingle();

  if (!userRow) {
    await ctx.editMessageText(`❌ User not found: ${userTelegramId}`, { parse_mode: 'HTML' });
    return;
  }

  try {
    await creditWallet(ctx.db, {
      userId: userRow.id,
      amountCents,
      kind: 'topup',
      idempotencyKey,
      note: `bKash approved by admin — TrxID: ${trxId}`,
    });

    // Update topup status to confirmed
    await ctx.db
      .from('topups')
      .update({ status: 'confirmed' })
      .eq('external_id', trxId);

    const amountUsd = (amountCents / 100).toFixed(2);

    // Update admin message
    await ctx.editMessageText(
      `✅ <b>Approved & Credited</b>\nTrxID: <code>${trxId}</code> → $${amountUsd} → user ${userTelegramId}`,
      { parse_mode: 'HTML' },
    );

    // Notify the user
    const { data: newBalRow } = await ctx.db
      .from('users')
      .select('balance_cents')
      .eq('telegram_id', userTelegramId)
      .maybeSingle();

    const newBal = formatCents(newBalRow?.balance_cents ?? amountCents);
    const userKb = new InlineKeyboard()
      .text('💳 Wallet', cb('TOPUP'))
      .text('📲 Buy Number', cb('SVC_LIST', 1)).row()
      .text('🏠 Home', cb('HOME'));

    await ctx.api.sendMessage(
      userTelegramId,
      `✅ <b>bKash Payment Approved!</b>\n${HR}\n` +
      `TrxID: <code>${trxId}</code>\n` +
      `💵 Credited: <b>$${amountUsd}</b>\n` +
      `💳 New balance: <b>${newBal}</b>\n\n` +
      `আপনার wallet এ টাকা যোগ হয়েছে! 🎉`,
      { parse_mode: 'HTML', reply_markup: userKb },
    );

    console.log(`[bkash] approved trx=${trxId} user=${userTelegramId} $${amountUsd}`);
  } catch (e) {
    console.error('[bkash] approve failed:', e);
    await ctx.editMessageText(`❌ Credit failed. TrxID: ${trxId}. Check logs.`);
  }
}

/** Admin tapped Reject — notify user */
export async function handleBkashReject(
  ctx: BotContext,
  userTelegramId: number,
  trxId: string,
): Promise<void> {
  // Update topup status
  await ctx.db
    .from('topups')
    .update({ status: 'failed' })
    .eq('external_id', trxId);

  await ctx.editMessageText(
    `❌ <b>Rejected</b>\nTrxID: <code>${trxId}</code> — user ${userTelegramId} notified.`,
    { parse_mode: 'HTML' },
  );

  const userKb = new InlineKeyboard()
    .url('💬 Contact Support', SUPPORT_URL).row()
    .text('🏠 Home', cb('HOME'));

  await ctx.api.sendMessage(
    userTelegramId,
    `❌ <b>bKash Payment Rejected</b>\n${HR}\n` +
    `TrxID: <code>${trxId}</code>\n\n` +
    `আপনার payment verify হয়নি।\n` +
    `সমস্যা হলে Support এ contact করুন।`,
    { parse_mode: 'HTML', reply_markup: userKb },
  ).catch(() => undefined);

  console.log(`[bkash] rejected trx=${trxId} user=${userTelegramId}`);
}

// --- Nagad flow (3 steps) ---

export async function handleNagadEnter(ctx: BotContext): Promise<void> {
  const pay = await getPaySettings(ctx.db);
  if (!pay.nagad_enabled || !pay.nagad_number) { await ctx.reply('nagad_not_configured'); return; }
  await ctx.reply(
    '💰 <b>Nagad — BDT Payment</b>\n━━━━━━━━━━━━━━━\n\n' +
    `⭕️ <b>Dollar Rate = ${pay.nagad_rate_tk} TK</b>\n\n` +
    `🟢 <b>Send Money এখানে:</b>\n<code>${pay.nagad_number}</code>\n\n` +
    '━━━━━━━━━━━━━━━\n\n📌 <b>Steps:</b>\n' +
    '1️⃣ এই নম্বরে Send Money করুন\n2️⃣ Transaction ID paste করুন\n3️⃣ Amount (TK) submit করুন\n\n' +
    `⏱ Admin verify করার পর wallet এ যোগ হবে\n\n👇 <b>${NAGAD_TRXID_MARKER}:</b>`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Transaction ID e.g. ABC1234XYZ' } },
  );
}

export async function handleNagadTrxReply(ctx: BotContext, trxId: string): Promise<void> {
  const cleaned = trxId.trim();
  if (!cleaned || cleaned.length < 4) { await ctx.reply('❌ Invalid Transaction ID.'); return; }
  await ctx.reply(
    `✅ TrxID recorded: <code>${cleaned}</code>\n\nকত টাকা পাঠিয়েছেন লিখুন:\n<b>${NAGAD_AMOUNT_PREFIX}${cleaned}</b>`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Amount in TK e.g. 390' } },
  );
}

export async function handleNagadAmountReply(ctx: BotContext, input: string, trxId: string): Promise<void> {
  const pay = await getPaySettings(ctx.db);
  if (!pay.nagad_enabled || !pay.nagad_number) { await ctx.reply('❌ Nagad is not configured.'); return; }
  const amountTk = parseFloat(input.trim().replace(',', '.'));
  if (isNaN(amountTk) || amountTk <= 0) { await ctx.reply('❌ Invalid amount.'); return; }
  if (amountTk < pay.nagad_min_tk) {
    await ctx.reply(`❌ Minimum Nagad top-up is <b>${pay.nagad_min_tk} TK</b>.`, { parse_mode: 'HTML' }); return;
  }
  const idempKey = `nagad_${trxId}`;
  const { data: dup } = await ctx.db.from('ledger_entries').select('id').eq('idempotency_key', idempKey).maybeSingle();
  if (dup) { await ctx.reply(`⚠️ এই TrxID আগেই submit করা হয়েছে। TrxID: <code>${trxId}</code>`, { parse_mode: 'HTML' }); return; }
  const amountCents = Math.round((amountTk / pay.nagad_rate_tk) * 100);
  const amountUsd = (amountCents / 100).toFixed(2);
  await ctx.db.from('topups').insert({
    user_id: ctx.user.id, amount_cents: amountCents,
    method: 'nagad' as any, status: 'pending', external_id: trxId,
    note: `${amountTk} TK @ ${pay.nagad_rate_tk} TK/$`,
  } as any);
  await ctx.reply(
    `⏳ <b>Nagad Payment Submitted!</b>\n${HR}\nTrxID: <code>${trxId}</code>\nAmount: <b>${amountTk} TK</b> = <b>$${amountUsd}</b>\n\nAdmin verify করছেন — কয়েক মিনিটের মধ্যে wallet এ যোগ হবে।`,
    { parse_mode: 'HTML' },
  );
  const uname = ctx.user.username ? `@${ctx.user.username}` : ctx.user.first_name;
  const adminKb = new InlineKeyboard()
    .text(`✅ Approve $${amountUsd}`, cb('NG_APR', ctx.user.telegram_id, trxId, amountCents)).row()
    .text('❌ Reject', cb('NG_REJ', ctx.user.telegram_id, trxId));
  for (const aid of ctx.env.ADMIN_TELEGRAM_IDS) {
    await ctx.api.sendMessage(aid,
      `💰 <b>Nagad Payment — Pending</b>\n${HR}\n👤 ${uname} (<code>${ctx.user.telegram_id}</code>)\n📋 TrxID: <code>${trxId}</code>\n💵 <b>${amountTk} TK</b> → <b>$${amountUsd}</b>\n\nCheck Nagad app and tap below:`,
      { parse_mode: 'HTML', reply_markup: adminKb },
    ).catch(() => undefined);
  }
  console.log(`[nagad] pending trx=${trxId} user=${ctx.user.id} ${amountTk}TK`);
}

export async function handleNagadApprove(ctx: BotContext, userTelegramId: number, trxId: string, amountCents: number): Promise<void> {
  const idempKey = `nagad_${trxId}`;
  const { data: dup } = await ctx.db.from('ledger_entries').select('id').eq('idempotency_key', idempKey).maybeSingle();
  if (dup) { await ctx.editMessageText(`⚠️ Already credited. TrxID: <code>${trxId}</code>`, { parse_mode: 'HTML' }); return; }
  const { data: userRow } = await ctx.db.from('users').select('id').eq('telegram_id', userTelegramId).maybeSingle();
  if (!userRow) { await ctx.editMessageText(`❌ User not found: ${userTelegramId}`); return; }
  try {
    await creditWallet(ctx.db, { userId: (userRow as any).id, amountCents, kind: 'topup', idempotencyKey: idempKey, note: `Nagad approved — TrxID: ${trxId}` });
    await (ctx.db.from('topups') as any).update({ status: 'confirmed' }).eq('external_id', trxId);
    const amountUsd = (amountCents / 100).toFixed(2);
    await ctx.editMessageText(`✅ <b>Nagad Approved & Credited</b>\nTrxID: <code>${trxId}</code> → $${amountUsd} → user ${userTelegramId}`, { parse_mode: 'HTML' });
    const { data: bal } = await ctx.db.from('users').select('balance_cents').eq('telegram_id', userTelegramId).maybeSingle();
    const newBal = formatCents((bal as any)?.balance_cents ?? amountCents);
    const userKb = new InlineKeyboard().text('💳 Wallet', cb('TOPUP')).text('📲 Buy', cb('SVC_LIST', 1)).row().text('🏠 Home', cb('HOME'));
    await ctx.api.sendMessage(userTelegramId,
      `✅ <b>Nagad Payment Approved!</b>\n${HR}\nTrxID: <code>${trxId}</code>\n💵 Credited: <b>$${amountUsd}</b>\n💳 Balance: <b>${newBal}</b>\n\nআপনার wallet এ টাকা যোগ হয়েছে! 🎉`,
      { parse_mode: 'HTML', reply_markup: userKb },
    );
    console.log(`[nagad] approved trx=${trxId} user=${userTelegramId} $${amountUsd}`);
  } catch (e) { console.error('[nagad] approve failed:', e); await ctx.editMessageText(`❌ Credit failed. TrxID: ${trxId}.`); }
}

export async function handleNagadReject(ctx: BotContext, userTelegramId: number, trxId: string): Promise<void> {
  await (ctx.db.from('topups') as any).update({ status: 'failed' }).eq('external_id', trxId);
  await ctx.editMessageText(`❌ <b>Nagad Rejected</b>\nTrxID: <code>${trxId}</code> — user ${userTelegramId} notified.`, { parse_mode: 'HTML' });
  const userKb = new InlineKeyboard().url('💬 Contact Support', SUPPORT_URL).row().text('🏠 Home', cb('HOME'));
  await ctx.api.sendMessage(userTelegramId,
    `❌ <b>Nagad Payment Rejected</b>\n${HR}\nTrxID: <code>${trxId}</code>\n\nআপনার payment verify হয়নি। সমস্যা হলে Support এ contact করুন।`,
    { parse_mode: 'HTML', reply_markup: userKb },
  ).catch(() => undefined);
  console.log(`[nagad] rejected trx=${trxId} user=${userTelegramId}`);
}
