/**
 * Number actions — reuse, flag, renew, change-duration.
 *
 * Reuse: admin charges a flat reuse price (from settings.reuse_cost_cents)
 *   regardless of whether the upstream charged $0 (in-window) or $0.50
 *   (post-expiry). In-window reuse is pure margin. This implements the
 *   user's decision: "Always charge my reuse price."
 *
 * Flag: check allowFlag from upstream before calling — upstream returns 422
 *   if allowFlag is false, which counts as a breaker failure.
 *
 * Renew: upstream issues a NEW requestId (webhook: number_renewed). We update
 *   the order's request_id when we receive that webhook.
 *
 * Change-duration: show preview first (totalUpgradeCost), then confirm.
 *   Only upgrades allowed — upstream refuses 3 (can't downgrade).
 */

import type { BotContext } from '../middleware.js';
import { debitWallet, creditWallet, InsufficientFundsError, getBalanceCents } from '../../domain/wallet.js';
import { formatCents } from '../../domain/money.js';
import { esc, HR, otpBlock, expiryLine } from '../ui/format.js';
import { extractOtp } from '../../domain/pricing.js';
import { cb } from '../ui/codec.js';
import { InlineKeyboard } from 'grammy';

/** Reuse prompt — FREE for active LTR (paid rental), $0.80 charge for STR. */
export async function handleReusePrompt(ctx: BotContext, requestId: string): Promise<void> {
  // Check if this is an LTR order (free OTPs during rental period)
  const { data: order } = await ctx.db
    .from('orders')
    .select('plan,end_time')
    .eq('request_id', requestId)
    .eq('user_id', ctx.user.id)
    .single();

  const plan    = (order as any)?.plan as string ?? 'STR';
  const isLtr   = plan !== 'STR';
  const endTime = (order as any)?.end_time ? new Date((order as any).end_time as string) : null;
  const isActive = !endTime || endTime > new Date();

  // ── LTR: free during rental period ──────────────────────────────────────────
  if (isLtr && isActive) {
    const kb = new InlineKeyboard()
      .text('✅ Request OTP — Free', cb('ACT_REUSE_CFM', requestId)).row()
      .text('❌ Cancel', cb('HOME'));

    await ctx.reply(
      `🔄 <b>Get OTP</b>\n${HR}\n` +
      `Your LTR number is active — OTPs during the rental period are <b>included at no charge</b>.\n\n` +
      `A new OTP will be sent when received.`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
    return;
  }

  // ── STR: $0.80 charge ────────────────────────────────────────────────────────
  const { data: settings } = await ctx.db
    .from('settings')
    .select('reuse_cost_cents')
    .single();
  const reuseCents = (settings as { reuse_cost_cents: number } | null)?.reuse_cost_cents ?? 80;
  const balance    = await getBalanceCents(ctx.db, ctx.user.telegram_id);

  const text =
    `🔄 <b>Get Another OTP</b>\n${HR}\n` +
    `⚠️ <b>This will charge ${formatCents(reuseCents)} from your balance.</b>\n` +
    `Each OTP request after the first is charged at this rate.\n\n` +
    `Your balance: <b>${formatCents(balance)}</b>` +
    (balance < reuseCents ? `\n\n❌ <b>Insufficient balance.</b> Please top up first.` : '');

  if (balance < reuseCents) {
    await ctx.reply(text, { parse_mode: 'HTML' });
    return;
  }

  const kb = new InlineKeyboard()
    .text(`✅ Confirm — Pay ${formatCents(reuseCents)}`, cb('ACT_REUSE_CFM', requestId)).row()
    .text('❌ Cancel', cb('HOME'));

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

/** Reuse execute — free for LTR, debit $0.80 for STR. */
export async function handleReuseExecute(ctx: BotContext, requestId: string): Promise<void> {
  const idempotencyKey = (ctx.callbackQuery?.id ?? '') + '_reuse';

  // Check plan type
  const { data: order } = await ctx.db
    .from('orders')
    .select('plan')
    .eq('request_id', requestId)
    .eq('user_id', ctx.user.id)
    .single();

  const plan   = (order as any)?.plan as string ?? 'STR';
  const isLtr  = plan !== 'STR';

  // ── LTR: free — just call upstream ──────────────────────────────────────────
  if (isLtr) {
    try {
      await ctx.pva.reuseRequest(requestId);
      await ctx.editMessageText(
        `🔄 <b>OTP Requested!</b>\n${HR}\n` +
        `A new OTP will be sent to your number shortly.\n` +
        `<i>Included in your LTR rental — no charge.</i>`,
        { parse_mode: 'HTML' },
      ).catch(() => ctx.reply('✅ OTP requested. No charge (LTR rental).'));
    } catch {
      await ctx.reply('❌ Could not request OTP. Try again.');
    }
    return;
  }

  // ── STR: charge $0.80 ────────────────────────────────────────────────────────
  const { data: settings } = await ctx.db
    .from('settings')
    .select('reuse_cost_cents')
    .single();
  const reuseCents = (settings as { reuse_cost_cents: number } | null)?.reuse_cost_cents ?? 80;

  try {
    await debitWallet(ctx.db, {
      userId: ctx.user.id,
      amountCents: reuseCents,
      kind: 'reuse',
      idempotencyKey,
      note: `Reuse OTP ${requestId.slice(0, 12)}`,
    });
  } catch (e) {
    if (e instanceof InsufficientFundsError) {
      await ctx.editMessageText(`❌ Insufficient balance. Need ${formatCents(reuseCents)}.`).catch(() => ctx.reply('❌ Insufficient balance.'));
      return;
    }
    await ctx.reply('❌ Could not process payment. Try again.');
    return;
  }

  try {
    await ctx.pva.reuseRequest(requestId);
    
    // ── STR Reuse logic: Mark RESERVED and increment reuse_count ────────────────
    const { data: currentOrder } = await ctx.db
      .from('orders')
      .select('id, reuse_count')
      .eq('request_id', requestId)
      .eq('user_id', ctx.user.id)
      .single();

    if (currentOrder) {
      const currentCount = (currentOrder as any).reuse_count ?? 0;
      await ctx.db.from('orders')
        .update({ 
          status: 'RESERVED', 
          updated_at: new Date().toISOString(),
          reuse_count: currentCount + 1 
        } as any)
        .eq('id', (currentOrder as any).id);
    }

    await ctx.editMessageText(
      `🔄 <b>OTP Request Sent!</b>\n${HR}\n` +
      `A new OTP will be sent to your number shortly.\n` +
      `Charged: <b>${formatCents(reuseCents)}</b>`,
      { parse_mode: 'HTML' },
    ).catch(() => ctx.reply(`✅ OTP requested. Cost: ${formatCents(reuseCents)}.`));
  } catch {
    await creditWallet(ctx.db, {
      userId: ctx.user.id,
      amountCents: reuseCents,
      kind: 'refund',
      idempotencyKey: idempotencyKey + '_refund',
      note: 'Auto-refund: reuse failed',
    });
    await ctx.reply('❌ Could not request OTP. Your payment has been refunded.');
  }
}

/** Flag — mark number as bad. Only allowed BEFORE an OTP is received. */
export async function handleFlag(ctx: BotContext, requestId: string): Promise<void> {
  // Always verify allowFlag live — upstream sets it false once OTP delivered
  let req;
  try {
    req = await ctx.pva.getRequest(requestId);
  } catch {
    await ctx.reply('❌ Could not verify number status. Try again.');
    return;
  }

  if (!req.allowFlag) {
    await ctx.reply(
      '🚫 <b>Cannot refund this number.</b>\n\n' +
      'Refunding is only allowed <b>before</b> an OTP is received.\n' +
      'Once you have received a verification code, the number cannot be refunded.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  try {
    await ctx.pva.flagRequest(requestId);

    // ── Fetch order to get refund amount ─────────────────────────────────────
    const { data: order } = await ctx.db
      .from('orders')
      .select('id, sell_cents')
      .eq('request_id', requestId)
      .eq('user_id', ctx.user.id)
      .maybeSingle();

    // Mark CANCELLED
    await ctx.db
      .from('orders')
      .update({ status: 'CANCELLED' } as any)
      .eq('request_id', requestId)
      .eq('user_id', ctx.user.id);

    // ── Auto-refund purchase price ────────────────────────────────────────────
    let refundMsg = '';
    if (order) {
      const sellCents = (order as any).sell_cents as number;
      const orderId   = (order as any).id as string;
      await creditWallet(ctx.db, {
        userId:         ctx.user.id,
        amountCents:    sellCents,
        kind:           'refund',
        idempotencyKey: `flag_refund_${orderId}`,
        note:           `Auto-refund: number flagged`,
      });
      refundMsg = `\n\n💳 <b>${formatCents(sellCents)} refunded</b> to your wallet.`;
    }

    await ctx.reply(
      `🚩 <b>Number Refunded</b>\n` +
      `The provider has been notified and the number has been cancelled.` +
      refundMsg,
      { parse_mode: 'HTML' },
    );
  } catch {
    await ctx.reply('❌ Could not refund number. Try again later.');
  }
}

/** Renew LTR — show duration + non-refundable warning before proceeding. */
export async function handleRenewPrompt(ctx: BotContext, requestId: string): Promise<void> {
  const { data: order } = await ctx.db
    .from('orders')
    .select('id,sell_cents,plan,service_name,number,end_time')
    .eq('request_id', requestId)
    .eq('user_id', ctx.user.id)
    .single();

  if (!order) {
    await ctx.reply('❌ Number not found.');
    return;
  }

  const durationMap: Record<string, number> = { LTR3: 3, LTR7: 7, LTR14: 14, LTR30: 30 };
  const plan        = (order as any).plan as string;
  const duration    = durationMap[plan] ?? 3;   // current rental duration
  const sellCents   = (order as any).sell_cents as number;
  const balance     = await getBalanceCents(ctx.db, ctx.user.telegram_id);
  const number      = (order as any).number as string;
  const svc         = (order as any).service_name as string;
  const endTime     = (order as any).end_time as string;

  // Renewal always uses the SAME duration — can't go lower
  // If they want a longer period they should use Upgrade Duration first
  const text =
    `🔁 <b>New Number (Renew)</b>\n${HR}\n` +
    `Number: <code>${number}</code>\n` +
    `Service: <b>${esc(svc)}</b>\n` +
    `Duration: <b>${duration} days</b> (same as current)\n` +
    `Current expiry: <b>${new Date(endTime).toUTCString()}</b>\n\n` +
    `⚠️ <b>Are you sure?</b>\n` +
    `• Starts a new <b>${duration}-day</b> rental from now\n` +
    `• <b>Non-refundable</b> once confirmed\n` +
    `• Duration cannot be shorter than original (${duration}d)\n` +
    `• To get a longer period, use <b>⇅ Upgrade Duration</b> first\n\n` +
    `Renewal cost: <b>${formatCents(sellCents)}</b>\n` +
    `Your balance: <b>${formatCents(balance)}</b>` +
    (balance < sellCents ? `\n\n❌ <b>Insufficient balance.</b> Please top up first.` : '');

  if (balance < sellCents) {
    await ctx.reply(text, { parse_mode: 'HTML' });
    return;
  }

  const kb = new InlineKeyboard()
    .text(`✅ Confirm ${duration}d Renewal — Pay ${formatCents(sellCents)}`, cb('ACT_RENEW_CFM', requestId)).row()
    .text('❌ Cancel', cb('HOME'));

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

/** Renew LTR execute — charge wallet then call upstream. */
export async function handleRenewExecute(ctx: BotContext, requestId: string): Promise<void> {
  const idempotencyKey = (ctx.callbackQuery?.id ?? '') + '_renew';

  const { data: order } = await ctx.db
    .from('orders')
    .select('id,sell_cents')
    .eq('request_id', requestId)
    .eq('user_id', ctx.user.id)
    .single();

  if (!order) {
    await ctx.reply('❌ Number not found.');
    return;
  }

  const sellCents = (order as any).sell_cents as number;

  // 1. Debit wallet
  try {
    await debitWallet(ctx.db, {
      userId: ctx.user.id,
      amountCents: sellCents,
      kind: 'purchase',
      idempotencyKey,
      note: `LTR renewal ${requestId.slice(0, 12)}`,
    });
  } catch (e) {
    if (e instanceof InsufficientFundsError) {
      await ctx.editMessageText(`❌ Insufficient balance. Need ${formatCents(sellCents)}.`).catch(() => ctx.reply('❌ Insufficient balance.'));
      return;
    }
    await ctx.reply('❌ Could not process payment. Try again.');
    return;
  }

  // 2. Call upstream renew
  try {
    await ctx.pva.renewLtr(requestId);

    // Mark as renewed — prevents auto-refund if it expires without a new OTP
    // @ts-ignore
    await ctx.db.from('orders').update({ is_renewed: true }).eq('request_id', requestId);

    await ctx.editMessageText(
      `✅ <b>Renewal Confirmed!</b>\n${HR}\n` +
      `Charged: <b>${formatCents(sellCents)}</b>\n` +
      `Your number expiry will be updated shortly.\n\n` +
      `⚠️ <i>Note: this renewal is non-refundable even if no OTP arrives.</i>\n` +
      `<i>The updated expiry will appear in My Numbers after confirmation.</i>`,
      { parse_mode: 'HTML' },
    ).catch(() => ctx.reply(`✅ Renewal confirmed. Cost: ${formatCents(sellCents)}.`));
  } catch {
    // Refund if upstream fails
    await creditWallet(ctx.db, {
      userId: ctx.user.id,
      amountCents: sellCents,
      kind: 'refund',
      idempotencyKey: idempotencyKey + '_refund',
      note: 'Auto-refund: LTR renewal upstream failed',
    });
    await ctx.reply('❌ Renewal failed. Your payment has been refunded.');
  }
}


/** Change duration — show upgrade preview with NON-REFUNDABLE warning. */
export async function handleChangeDurationPreview(
  ctx: BotContext,
  requestId: string,
  targetDuration: 7 | 14 | 30,
): Promise<void> {
  try {
    const preview = await ctx.pva.previewChangeDuration(requestId, targetDuration);

    const kb = new InlineKeyboard()
      .text(`✅ Confirm Upgrade to ${targetDuration}d`, cb('ACT_DUR_CFM', requestId.slice(0, 18), targetDuration)).row()
      .text('❌ Cancel', cb('HOME'));

    await ctx.reply(
      `⬆️ <b>Duration Upgrade</b>\n${HR}\n` +
      `Current: <b>${preview.currentDuration} days</b>\n` +
      `Target: <b>${preview.targetDuration} days</b>\n` +
      `Upgrade fee: <b>$${preview.fixedUpgradeFee.toFixed(2)}</b>\n` +
      `Duration diff: <b>$${preview.durationPriceDifference.toFixed(2)}</b>\n` +
      `<b>Total cost: $${preview.totalUpgradeCost.toFixed(2)}</b>\n` +
      `New expiry: <b>${new Date(preview.newExpiry).toUTCString()}</b>\n\n` +
      `⚠️ <b>Duration upgrades are NON-REFUNDABLE</b> — this applies even if you haven't received an OTP yet.`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  } catch {
    await ctx.reply('❌ Could not fetch upgrade preview. Try again.');
  }
}

/** Change duration — commit using full requestId looked up from DB. */
export async function handleChangeDurationCommit(
  ctx: BotContext,
  shortRequestId: string,
  targetDuration: 7 | 14 | 30,
): Promise<void> {
  // Look up the full requestId from DB (callback only carries 18-char prefix)
  const { data: order } = await ctx.db
    .from('orders')
    .select('id,request_id,plan,sell_cents')
    .eq('user_id', ctx.user.id)
    .like('request_id', `${shortRequestId}%`)
    .single();

  if (!order) {
    await ctx.reply('❌ Number not found.');
    return;
  }

  const fullRequestId = (order as any).request_id as string;
  const currentPlan   = (order as any).plan as string;
  const durationMap: Record<string, number> = { LTR3: 3, LTR7: 7, LTR14: 14, LTR30: 30 };
  const currentDur    = durationMap[currentPlan] ?? 3;

  // Guard: target must be strictly greater than current
  if (targetDuration <= currentDur) {
    await ctx.reply(`❌ Cannot downgrade. Current plan is ${currentDur}d. Choose ${currentDur < 7 ? '7, 14 or 30' : currentDur < 14 ? '14 or 30' : '30'} days.`);
    return;
  }

  try {
    const req = await ctx.pva.commitChangeDuration(fullRequestId, targetDuration);
    // Update plan in DB
    const newPlan = `LTR${targetDuration}` as string;
    // @ts-ignore
    await ctx.db.from('orders').update({ plan: newPlan }).eq('id', (order as any).id);
    await ctx.reply(
      `✅ Duration upgraded to <b>${targetDuration} days</b>!\n` +
      expiryLine(req.endTime),
      { parse_mode: 'HTML' },
    );
  } catch {
    await ctx.reply('❌ Could not complete upgrade. If your wallet was charged, contact support.');
  }
}

/** Toggle auto-renew flag for an LTR number. */
export async function handleToggleAutoRenew(ctx: BotContext, requestId: string): Promise<void> {
  const { data: order } = await ctx.db
    .from('orders')
    .select('id,auto_renew')
    .eq('request_id', requestId)
    .eq('user_id', ctx.user.id)
    .single();

  if (!order) {
    await ctx.reply('❌ Number not found.');
    return;
  }

  const current  = (order as any).auto_renew as boolean ?? false;
  const newValue = !current;

  // @ts-ignore
  await ctx.db.from('orders').update({ auto_renew: newValue }).eq('id', (order as any).id);

  const label = newValue ? '🟢 ON' : '🔴 OFF';
  // Note: ctx.answerCallbackQuery() already called by middleware
  // Refresh the number view — use first 20 chars as prefix for DB lookup
  const { handleNumberView } = await import('./my-numbers.js');
  await handleNumberView(ctx, requestId.slice(0, 20));
}
