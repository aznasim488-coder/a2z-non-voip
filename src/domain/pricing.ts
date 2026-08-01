/**
 * Pricing resolution — three-level cascade:
 *   1. Service-level manual override (service_prices table)
 *   2. Plan default rule (plan_defaults table)
 *   3. Global multiplier rule (settings table)
 *
 * All amounts are integer cents. A floor of costCents + minMarginCents is
 * always applied so admins can't accidentally sell below cost.
 *
 * Plan codes match the DB enum plan_code:
 *   STR | LTR3 | LTR7 | LTR14 | LTR30 | ALL_SERVICES_US | ALL_SERVICES_UK | REUSE
 */

import { ceilCents } from './money.js';

export type PlanCode =
  | 'STR'
  | 'LTR3'
  | 'LTR7'
  | 'LTR14'
  | 'LTR30'
  | 'ALL_SERVICES_US'
  | 'ALL_SERVICES_UK'
  | 'REUSE';

export type PriceMode = 'fixed' | 'multiplier' | 'markup';

export interface PriceRule {
  mode: PriceMode;
  fixedSellCents?: number | null;
  multiplierBp?: number | null;   // basis points (2000 = ×2.00)
  markupPercent?: number | null;
  markupFlatCents?: number | null;
}

export interface PricingContext {
  plan: PlanCode;
  costCents: number;
  explicitSellCents?: number | null;  // service_prices override
  planRule?: PriceRule | null;        // plan_defaults rule
  globalRule: PriceRule;              // settings global rule
  minMarginCents: number;             // settings.global_min_margin_cents
}

export interface PriceResult {
  plan: PlanCode;
  costCents: number;
  sellCents: number;
  marginCents: number;
  source: 'override' | 'plan_default' | 'global';
  floored: boolean;
}

export function applyRule(costCents: number, rule: PriceRule): number | null {
  switch (rule.mode) {
    case 'fixed':
      return rule.fixedSellCents ?? null;
    case 'multiplier': {
      const bp = rule.multiplierBp ?? 0;
      if (bp <= 0) return null;
      return ceilCents((costCents * bp) / 10_000);
    }
    case 'markup': {
      const pct = rule.markupPercent ?? 0;
      const flat = rule.markupFlatCents ?? 0;
      return costCents + ceilCents((costCents * pct) / 100) + flat;
    }
  }
}

export function resolvePrice(ctx: PricingContext): PriceResult {
  let sellCents: number;
  let source: PriceResult['source'];

  if (ctx.explicitSellCents != null && ctx.explicitSellCents > 0) {
    sellCents = ctx.explicitSellCents;
    source = 'override';
  } else if (ctx.planRule) {
    const fromPlan = applyRule(ctx.costCents, ctx.planRule);
    if (fromPlan != null && fromPlan > 0) {
      sellCents = fromPlan;
      source = 'plan_default';
    } else {
      sellCents = applyRule(ctx.costCents, ctx.globalRule) ?? ctx.costCents;
      source = 'global';
    }
  } else {
    sellCents = applyRule(ctx.costCents, ctx.globalRule) ?? ctx.costCents;
    source = 'global';
  }

  const floor = ctx.costCents + ctx.minMarginCents;
  const floored = sellCents < floor;
  if (floored) sellCents = floor;

  return {
    plan: ctx.plan,
    costCents: ctx.costCents,
    sellCents,
    marginCents: sellCents - ctx.costCents,
    source,
    floored,
  };
}

export function describeRule(rule: PriceRule): string {
  switch (rule.mode) {
    case 'fixed':
      return `fixed $${((rule.fixedSellCents ?? 0) / 100).toFixed(2)}`;
    case 'multiplier':
      return `cost ×${((rule.multiplierBp ?? 0) / 10_000).toFixed(2)}`;
    case 'markup': {
      const pct = rule.markupPercent ?? 0;
      const flat = rule.markupFlatCents ?? 0;
      return `cost +${pct}%${flat ? ` +${(flat / 100).toFixed(2)}` : ''}`;
    }
  }
}

/** Try to extract an OTP code from an SMS body. */
export function extractOtp(body: string): string | null {
  // 1. Keyword-anchored
  const m1 = /(?:code|otp|pin|password|verification)\D{0,20}?(\d{4,8})/i.exec(body);
  if (m1) return m1[1]!;
  // 2. Spaced / dashed 6-digit  e.g. "123 456" or "123-456"
  const m2 = /\b(\d{3}[- ]\d{3})\b/.exec(body);
  if (m2) return m2[1]!.replace(/[- ]/, '');
  // 3. Bare standalone number
  const m3 = /\b(\d{4,8})\b/.exec(body);
  return m3 ? m3[1]! : null;
}
