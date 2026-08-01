/**
 * Purchase flow — debit-first, then upstream call, refund on failure.
 *
 * Idempotency key = ctx.callbackQuery.id (Telegram guarantees each button
 * press gets a unique callback_query_id, but retries reuse the same id).
 * This means double-taps collapse to one charge automatically.
 *
 * Flow:
 *   1. Check upstream health + breaker
 *   2. Resolve sell price
 *   3. Check customer balance
 *   4. debitWallet (idempotent)
 *   5. createOrder (status PENDING_UPSTREAM)
 *   6. purchaseUpstream
 *   7a. Success → updateOrderSuccess + notify user
 *   7b. Failure → updateOrderFailed + creditWallet refund + notify user
 */

import type { BotContext } from '../middleware.js';
import { confirmKb } from '../ui/keyboards.js';
import { esc, HR, phoneBlock, expiryLine } from '../ui/format.js';
import { formatCents as fc } from '../../domain/money.js';
import { debitWallet, creditWallet, InsufficientFundsError, getBalanceCents } from '../../domain/wallet.js';
import { createOrder, updateOrderSuccess, updateOrderFailed } from '../../domain/orders.js';
import { resolvePrice, type PlanCode } from '../../domain/pricing.js';
import { BreakerOpenError, UpstreamDownError } from '../../upstream/client.js';

// Mapping from plan code to upstream call
type PurchasePlan =
  | { plan: 'STR'; serviceId: string }
  | { plan: 'LTR3' | 'LTR7' | 'LTR14' | 'LTR30'; serviceId: string }
  | { plan: 'ALL_SERVICES_US' | 'ALL_SERVICES_UK' };

const DURATION_MAP: Record<string, 3 | 7 | 14 | 30> = {
  LTR3: 3, LTR7: 7, LTR14: 14, LTR30: 30,
};

/** Show confirmation message before charging the customer. */
export async function handleBuyConfirm(
  ctx: BotContext,
  plan: PlanCode,
  shortId: number,
): Promise<void> {
  // Look up sell price
  const { sellCents, serviceName } = await resolveSellPrice(ctx, plan, shortId);
  if (sellCents === null || serviceName === null) {
    await ctx.editMessageText('❌ Service not found or no price configured.').catch(() => undefined);
    return;
  }

  const balance = await getBalanceCents(ctx.db, ctx.user.telegram_id);

  const planLabel: Record<PlanCode, string> = {
    STR: '20-min STR',
    LTR3: '3-day LTR',
    LTR7: '7-day LTR',
    LTR14: '14-day LTR',
    LTR30: '30-day LTR',
    ALL_SERVICES_US: 'ALL_SERVICES US 20-min',
    ALL_SERVICES_UK: 'ALL_SERVICES UK 30-day',
    REUSE: 'Get OTP',
  };

  const text =
    `🛒 <b>Confirm Purchase</b>\n${HR}\n` +
    `Service: <b>${esc(serviceName)}</b>\n` +
    `Plan: <b>${planLabel[plan]}</b>\n` +
    `Price: <b>${fc(sellCents)}</b>\n\n` +
    `Your balance: <b>${fc(balance)}</b>\n` +
    (balance < sellCents ? `\n⚠️ <b>Insufficient balance.</b> Please top up first.` : '');

  if (balance < sellCents) {
    await ctx.editMessageText(text, { parse_mode: 'HTML' }).catch(() =>
      ctx.reply(text, { parse_mode: 'HTML' }),
    );
    return;
  }

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: confirmKb(plan, shortId),
  }).catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: confirmKb(plan, shortId) }));
}

/** Execute the purchase after customer confirmation. */
export async function handleBuyExecute(
  ctx: BotContext,
  plan: PlanCode,
  shortId: number,
): Promise<void> {
  const idempotencyKey = ctx.callbackQuery?.id ?? '';

  // Get service info and price
  const { sellCents, costCents, serviceId, serviceName } = await resolveSellPrice(ctx, plan, shortId);
  if (sellCents === null || serviceId === null || serviceName === null || costCents === null) {
    await ctx.reply('❌ Service not found. Please go back and try again.');
    return;
  }

  // Check upstream health before charging
  try {
    ctx.pva.health.assertHealthy();
    ctx.pva.breaker.assertClosed();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Service unavailable.';
    await ctx.reply(`❌ ${esc(msg)}`);
    return;
  }

  // Debit wallet first
  let newBalance: number;
  try {
    newBalance = await debitWallet(ctx.db, {
      userId: ctx.user.id,
      amountCents: sellCents,
      kind: 'purchase',
      idempotencyKey,
      note: `${plan} ${serviceName}`,
    });
  } catch (e) {
    if (e instanceof InsufficientFundsError) {
      await ctx.reply('❌ Insufficient balance. Please top up your wallet first.');
      return;
    }
    await ctx.reply('❌ Could not process payment. Please try again.');
    return;
  }

  // Create order record
  const order = await createOrder(ctx.db, {
    userId: ctx.user.id,
    serviceId: serviceId ?? '',
    serviceName: serviceName ?? '',
    plan,
    sellCents,
    costCents: costCents ?? 0,
    idempotencyKey,
  });

  await ctx.reply('⏳ Purchasing your number, please wait...', { parse_mode: 'HTML' });

  // Call upstream
  try {
    const result = await executePurchase(ctx, plan, serviceId ?? '');

    await updateOrderSuccess(ctx.db, order.id, {
      requestId: result.requestId,
      number: result.number,
      status: result.status as 'RESERVED',
      endTime: result.endTime,
    });

    const sentMsg = await ctx.reply(
      `✅ <b>Number Purchased!</b>\n${HR}\n` +
      phoneBlock(result.number) + '\n' +
      `Service: <b>${esc(result.serviceName)}</b>\n` +
      expiryLine(result.endTime) + '\n\n' +
      `💳 New balance: <b>${fc(newBalance)}</b>\n\n` +
      `📨 <b>OTP will appear here automatically</b> when received.\n` +
      `You can also check <b>My Numbers</b> at any time.`,
      { parse_mode: 'HTML' },
    );

    // Save message_id so the OTP notification can reply to this exact message
    await ctx.db
      .from('orders')
      // @ts-ignore
      .update({ purchase_msg_id: sentMsg.message_id })
      .eq('id', order.id);
  } catch (e) {
    // Refund on failure
    const errMsg = e instanceof Error ? e.message : 'Unknown error';
    await updateOrderFailed(ctx.db, order.id, errMsg);

    await creditWallet(ctx.db, {
      userId: ctx.user.id,
      amountCents: sellCents,
      kind: 'refund',
      idempotencyKey: idempotencyKey + '_refund',
      note: `Auto-refund: purchase failed`,
    });

    const isDown = e instanceof UpstreamDownError || e instanceof BreakerOpenError;
    await ctx.reply(
      isDown
        ? '❌ The number service is temporarily unavailable. Your payment has been refunded.'
        : '❌ Could not get a number right now. Your payment has been refunded.',
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveSellPrice(
  ctx: BotContext,
  plan: PlanCode,
  shortId: number,
): Promise<{
  sellCents: number | null;
  costCents: number | null;
  serviceId: string | null;
  serviceName: string | null;
}> {
  // Fetch settings for global rule + min margin
  const { data: rawSettings } = await ctx.db
    .from('settings')
    .select(
      'global_mode,global_fixed_cents,global_multiplier_bp,global_markup_percent,' +
      'global_markup_flat_cents,global_min_margin_cents,all_services_us_cost_cents,all_services_uk_cost_cents',
    )
    .single();

  if (!rawSettings) return { sellCents: null, costCents: null, serviceId: null, serviceName: null };

  const settings = rawSettings as unknown as {
    global_mode: 'fixed' | 'multiplier' | 'markup';
    global_fixed_cents?: number;
    global_multiplier_bp: number;
    global_markup_percent?: number;
    global_markup_flat_cents?: number;
    global_min_margin_cents: number;
    all_services_us_cost_cents: number;
    all_services_uk_cost_cents: number;
  };

  // For ALL_SERVICES plans, cost comes from settings
  if (plan === 'ALL_SERVICES_US' || plan === 'ALL_SERVICES_UK') {
    const costCents =
      plan === 'ALL_SERVICES_US'
        ? (settings.all_services_us_cost_cents ?? 1299)
        : (settings.all_services_uk_cost_cents ?? 699);

    const { data: planDef } = await ctx.db
      .from('plan_defaults')
      .select('sell_cents,mode,multiplier_bp,markup_percent,markup_flat_cents')
      .eq('plan', plan)
      .single();

    const pd = planDef as unknown as { sell_cents?: number; mode: string; multiplier_bp?: number; markup_percent?: number; markup_flat_cents?: number } | null;

    const result = resolvePrice({
      plan,
      costCents,
      explicitSellCents: pd?.sell_cents,
      planRule: pd ? {
        mode: pd.mode as 'multiplier',
        multiplierBp: pd.multiplier_bp,
        markupPercent: pd.markup_percent,
        markupFlatCents: pd.markup_flat_cents,
      } : null,
      globalRule: {
        mode: settings.global_mode,
        multiplierBp: settings.global_multiplier_bp,
        fixedSellCents: settings.global_fixed_cents,
        markupPercent: settings.global_markup_percent,
        markupFlatCents: settings.global_markup_flat_cents,
      },
      minMarginCents: settings.global_min_margin_cents,
    });

    return {
      sellCents: result.sellCents,
      costCents,
      serviceId: 'ALL_SERVICES',
      serviceName: plan === 'ALL_SERVICES_US' ? 'ALL_SERVICES (US)' : 'ALL_SERVICES (UK)',
    };
  }

  // Regular service
  const { data: svc } = await ctx.db
    .from('services_cache')
    .select('service_id,name,str_cost_cents,ltr3_cost_cents,ltr7_cost_cents,ltr14_cost_cents,ltr30_cost_cents')
    .eq('short_id', shortId)
    .single();

  if (!svc) return { sellCents: null, costCents: null, serviceId: null, serviceName: null };

  const costMap: Record<string, number> = {
    STR: svc.str_cost_cents as number,
    LTR3: svc.ltr3_cost_cents as number,
    LTR7: svc.ltr7_cost_cents as number,
    LTR14: svc.ltr14_cost_cents as number,
    LTR30: svc.ltr30_cost_cents as number,
  };
  const costCents = costMap[plan] ?? 0;

  const { data: override } = await ctx.db
    .from('service_prices')
    .select('sell_cents')
    .eq('service_id', svc.service_id)
    .eq('plan', plan)
    .is('tier_id', null)
    .single();

  const { data: planDef } = await ctx.db
    .from('plan_defaults')
    .select('sell_cents,mode,multiplier_bp,markup_percent,markup_flat_cents')
    .eq('plan', plan)
    .single();

  const pd2 = planDef as unknown as { sell_cents?: number; mode: string; multiplier_bp?: number; markup_percent?: number; markup_flat_cents?: number } | null;

  const result = resolvePrice({
    plan,
    costCents,
    explicitSellCents: (override as unknown as { sell_cents?: number } | null)?.sell_cents,
    planRule: pd2 ? {
      mode: pd2.mode as 'multiplier',
      fixedSellCents: pd2.sell_cents,
      multiplierBp: pd2.multiplier_bp,
      markupPercent: pd2.markup_percent,
      markupFlatCents: pd2.markup_flat_cents,
    } : null,
    globalRule: {
      mode: settings.global_mode,
      multiplierBp: settings.global_multiplier_bp,
      fixedSellCents: settings.global_fixed_cents,
      markupPercent: settings.global_markup_percent,
      markupFlatCents: settings.global_markup_flat_cents,
    },
    minMarginCents: settings.global_min_margin_cents,
  });

  return {
    sellCents: result.sellCents,
    costCents,
    serviceId: svc.service_id as string,
    serviceName: svc.name as string,
  };
}

async function executePurchase(
  ctx: BotContext,
  plan: PlanCode,
  serviceId: string,
): Promise<{ requestId: string; number: string; serviceName: string; status: string; endTime: string }> {
  switch (plan) {
    case 'STR':
      return ctx.pva.purchaseStr(serviceId);
    case 'LTR3':
      return ctx.pva.purchaseLtr(serviceId, 3);
    case 'LTR7':
      return ctx.pva.purchaseLtr(serviceId, 7);
    case 'LTR14':
      return ctx.pva.purchaseLtr(serviceId, 14);
    case 'LTR30':
      return ctx.pva.purchaseLtr(serviceId, 30);
    case 'ALL_SERVICES_US':
      return ctx.pva.purchaseAllServicesUs();
    case 'ALL_SERVICES_UK':
      return ctx.pva.purchaseAllServicesUk();
    default:
      throw new Error(`Unknown plan: ${plan}`);
  }
}
