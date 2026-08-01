/**
 * Admin pricing editor — plan defaults + service overrides + CSV export.
 *
 * Supported price formats:
 *   Fixed rate:        /setplan STR 0.18      → charge exactly $0.18
 *   Multiplier:        /setplan STR x2.5      → cost × 2.50
 *   Percent markup:    /setplan STR +60%      → cost + 60%
 *   Global fixed:      /setglobal $1.30
 *   Global multiplier: /setglobal x2.00
 *   Global % markup:   /setglobal +60%
 */

import type { BotContext } from '../middleware.js';
import { adminPricingKb } from '../ui/keyboards.js';
import { esc, HR } from '../ui/format.js';
import { formatCents } from '../../domain/money.js';
import { InlineKeyboard } from 'grammy';

const VALID_PLANS = ['STR','LTR3','LTR7','LTR14','LTR30','ALL_SERVICES_US','ALL_SERVICES_UK','REUSE'] as const;
type PlanCode = typeof VALID_PLANS[number];

type PlanRow = {
  plan: string;
  mode: string;
  sell_cents?: number | null;
  multiplier_bp?: number | null;
  markup_percent?: number | null;
  markup_flat_cents?: number | null;
};

function describePlanRow(d: PlanRow): string {
  if (d.sell_cents) return `fixed <b>${formatCents(d.sell_cents)}</b>`;
  if (d.mode === 'multiplier' && d.multiplier_bp) return `cost ×${(d.multiplier_bp / 10000).toFixed(2)}`;
  if (d.mode === 'markup' && d.markup_percent) return `cost +${d.markup_percent}%`;
  return d.mode;
}

export async function handleAdminPricing(ctx: BotContext): Promise<void> {
  const [{ data: defaults }, { data: settings }] = await Promise.all([
    ctx.db.from('plan_defaults').select('plan,mode,sell_cents,multiplier_bp,markup_percent,markup_flat_cents').order('plan'),
    ctx.db.from('settings').select('global_mode,global_multiplier_bp,global_fixed_cents,global_markup_percent,reuse_cost_cents,all_services_us_cost_cents,all_services_uk_cost_cents').single(),
  ]);

  const s = settings as {
    global_mode: string;
    global_multiplier_bp: number;
    global_fixed_cents?: number;
    global_markup_percent?: number;
    reuse_cost_cents: number;
    all_services_us_cost_cents: number;
    all_services_uk_cost_cents: number;
  } | null;

  // Describe global rule
  let globalDesc = 'not set';
  if (s) {
    if (s.global_mode === 'multiplier') globalDesc = `cost ×${(s.global_multiplier_bp / 10000).toFixed(2)}`;
    else if (s.global_mode === 'markup' && s.global_markup_percent) globalDesc = `cost +${s.global_markup_percent}%`;
    else if (s.global_mode === 'fixed' && s.global_fixed_cents) globalDesc = `fixed ${formatCents(s.global_fixed_cents)}`;
  }

  // Plan defaults table
  const rows = (defaults ?? []) as PlanRow[];
  const planLines = rows.map((d) =>
    `  <b>${esc(d.plan)}</b>: ${describePlanRow(d)}`
  );

  const text =
    `💰 <b>Admin Pricing</b>\n${HR}\n` +
    `<b>Global rule:</b> ${globalDesc}\n` +
    `<b>Reuse price:</b> ${formatCents(s?.reuse_cost_cents ?? 80)}\n` +
    `<b>ALL_SERVICES US cost:</b> ${formatCents(s?.all_services_us_cost_cents ?? 999)}\n` +
    `<b>ALL_SERVICES UK cost:</b> ${formatCents(s?.all_services_uk_cost_cents ?? 699)}\n\n` +
    `<b>Plan Defaults:</b>\n` +
    (planLines.length ? planLines.join('\n') : '  <i>none set</i>') +
    `\n\n<b>Set pricing commands:</b>\n` +
    `<code>/setplan STR 0.18</code> — fixed $0.18\n` +
    `<code>/setplan STR x2.50</code> — cost ×2.50\n` +
    `<code>/setplan STR +60%</code> — cost +60%\n` +
    `<code>/setglobal x2.00</code> — global ×2.00\n` +
    `<code>/setglobal +60%</code> — global +60%\n` +
    `<code>/setglobal $1.30</code> — global fixed\n` +
    `<code>/setreuse 0.80</code> — reuse price\n` +
    `<code>/exportcsv</code> — download CSV`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: adminPricingKb() });
}

/** /setplan <plan> <price>
 *  formats: 0.18 (fixed), x2.5 (multiplier), +60% (markup)
 */
export async function handleSetPlan(ctx: BotContext, plan: string, priceStr: string): Promise<void> {
  const planUp = plan.toUpperCase() as PlanCode;
  if (!(VALID_PLANS as readonly string[]).includes(planUp)) {
    await ctx.reply(`❌ Unknown plan. Valid: ${VALID_PLANS.join(', ')}`);
    return;
  }

  let update: Record<string, unknown>;
  let confirmMsg: string;

  if (priceStr.startsWith('x')) {
    // Multiplier: x2.50
    const mult = parseFloat(priceStr.slice(1));
    if (isNaN(mult) || mult <= 0) { await ctx.reply('❌ Invalid. Example: /setplan STR x2.50'); return; }
    const bp = Math.round(mult * 10_000);
    update = { plan: planUp, mode: 'multiplier', multiplier_bp: bp, sell_cents: null, markup_percent: null };
    confirmMsg = `cost ×${mult.toFixed(2)}`;

  } else if (priceStr.startsWith('+') && priceStr.endsWith('%')) {
    // Percent markup: +60%
    const pct = parseFloat(priceStr.slice(1, -1));
    if (isNaN(pct) || pct < 0) { await ctx.reply('❌ Invalid. Example: /setplan STR +60%'); return; }
    update = { plan: planUp, mode: 'markup', markup_percent: pct, sell_cents: null, multiplier_bp: null };
    confirmMsg = `cost +${pct}%`;

  } else {
    // Fixed dollar: 0.18
    const price = parseFloat(priceStr);
    if (isNaN(price) || price < 0) { await ctx.reply('❌ Invalid. Example: /setplan STR 0.18'); return; }
    const cents = Math.round(price * 100);
    update = { plan: planUp, mode: 'fixed', sell_cents: cents, multiplier_bp: null, markup_percent: null };
    confirmMsg = `fixed ${formatCents(cents)}`;
  }

  const { error } = await ctx.db
    .from('plan_defaults')
    .upsert(update as any, { onConflict: 'plan' });

  if (error) { await ctx.reply('❌ DB error: ' + esc(error.message)); return; }
  await ctx.reply(`✅ <b>${esc(planUp)}</b> plan → <b>${confirmMsg}</b>`, { parse_mode: 'HTML' });
}

/** /setreuse <price> */
export async function handleSetReuse(ctx: BotContext, priceStr: string): Promise<void> {
  const price = parseFloat(priceStr);
  if (isNaN(price) || price < 0) { await ctx.reply('❌ Invalid. Example: /setreuse 0.80'); return; }
  const cents = Math.round(price * 100);
  await ctx.db.from('settings').update({ reuse_cost_cents: cents } as any).eq('id', true);
  await ctx.reply(`✅ Reuse price set to <b>${formatCents(cents)}</b>`, { parse_mode: 'HTML' });
}

/** /setglobal x2.00 | /setglobal +60% | /setglobal $1.30 */
export async function handleSetGlobal(ctx: BotContext, valueStr: string): Promise<void> {
  let update: Record<string, unknown>;
  let confirmMsg: string;

  const v = valueStr.trim();

  if (v.startsWith('x')) {
    const mult = parseFloat(v.slice(1));
    if (isNaN(mult) || mult <= 0) { await ctx.reply('❌ Invalid. Example: /setglobal x2.00'); return; }
    const bp = Math.round(mult * 10_000);
    update = { global_mode: 'multiplier', global_multiplier_bp: bp, global_fixed_cents: null, global_markup_percent: null };
    confirmMsg = `cost ×${mult.toFixed(2)}`;

  } else if (v.startsWith('+') && v.endsWith('%')) {
    const pct = parseFloat(v.slice(1, -1));
    if (isNaN(pct) || pct < 0) { await ctx.reply('❌ Invalid. Example: /setglobal +60%'); return; }
    update = { global_mode: 'markup', global_markup_percent: pct, global_fixed_cents: null };
    confirmMsg = `cost +${pct}%`;

  } else if (v.startsWith('$')) {
    const dollars = parseFloat(v.slice(1));
    if (isNaN(dollars)) { await ctx.reply('❌ Invalid. Example: /setglobal $1.30'); return; }
    const cents = Math.round(dollars * 100);
    update = { global_mode: 'fixed', global_fixed_cents: cents, global_markup_percent: null };
    confirmMsg = `fixed ${formatCents(cents)}`;

  } else {
    await ctx.reply(
      '❌ Format:\n' +
      '<code>/setglobal x2.00</code> — multiplier\n' +
      '<code>/setglobal +60%</code> — percent markup\n' +
      '<code>/setglobal $1.30</code> — flat price',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const { error } = await ctx.db.from('settings').update(update as any).eq('id', true);
  if (error) { await ctx.reply('❌ DB error: ' + esc(error.message)); return; }
  await ctx.reply(`✅ Global pricing → <b>${confirmMsg}</b>`, { parse_mode: 'HTML' });
}

/** /exportcsv — pipe-delimited price overrides as document. */
export async function handleExportCsv(ctx: BotContext): Promise<void> {
  const { data: prices } = await ctx.db
    .from('service_prices')
    .select('service_id,plan,sell_cents,note')
    .order('service_id');

  const rows = [
    'service_id|plan|sell_cents|note',
    ...(prices ?? []).map((p: { service_id: string; plan: string; sell_cents: number; note?: string }) =>
      `${p.service_id}|${p.plan}|${p.sell_cents}|${p.note ?? ''}`
    ),
  ];

  const { InputFile } = await import('grammy');
  const buf = Buffer.from(rows.join('\n'), 'utf8');
  await ctx.replyWithDocument(
    new InputFile(buf, `prices_${new Date().toISOString().slice(0, 10)}.csv`),
    { caption: `📊 Price overrides — ${(prices ?? []).length} rows` },
  );
}
