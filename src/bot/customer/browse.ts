/**
 * Service browsing — paginated + searchable + deduplicated list.
 *
 * Same-name services that differ only by country (US vs UK) are shown as a
 * single entry. Tapping shows a country picker first. Tapping a country then
 * shows the full detail with marked-up sell prices.
 *
 * Pricing: three-level cascade (override → plan default → global rule).
 */

import type { BotContext } from '../middleware.js';
import { serviceListKb, buyOptionsKb, allServicesKb, countryPickKb } from '../ui/keyboards.js';
import { esc, HR } from '../ui/format.js';
import { formatCents } from '../../domain/money.js';
import { resolvePrice, type PlanCode, type PriceRule } from '../../domain/pricing.js';
import { cb } from '../ui/codec.js';

const PAGE_SIZE = 8;

// ─── Types ────────────────────────────────────────────────────────────────────

type SvcRow = {
  short_id: number;
  service_id: string;
  name: string;
  country: string;
  str_cost_cents: number;
  ltr3_cost_cents: number;
  ltr7_cost_cents: number;
  ltr14_cost_cents: number;
  ltr30_cost_cents: number;
  str_stock: number;
  ltr_stock: number;
};

type DbSettings = {
  global_mode: string;
  global_multiplier_bp: number;
  global_fixed_cents?: number | null;
  global_markup_percent?: number | null;
  global_markup_flat_cents?: number | null;
  global_min_margin_cents: number;
  reuse_cost_cents: number;
  all_services_us_cost_cents: number;
  all_services_uk_cost_cents: number;
};

type DbPlanDefault = {
  plan: string;
  mode: string;
  sell_cents?: number | null;
  multiplier_bp?: number | null;
  markup_percent?: number | null;
  markup_flat_cents?: number | null;
};

// ─── Pricing helpers ──────────────────────────────────────────────────────────

async function loadPricingConfig(ctx: BotContext) {
  const [{ data: settingsRow }, { data: planRows }] = await Promise.all([
    ctx.db.from('settings').select('*').single(),
    ctx.db.from('plan_defaults').select('plan,mode,sell_cents,multiplier_bp,markup_percent,markup_flat_cents'),
  ]);

  const settings: DbSettings = (settingsRow as DbSettings) ?? {
    global_mode: 'multiplier', global_multiplier_bp: 20000,
    global_min_margin_cents: 1, reuse_cost_cents: 80,
    all_services_us_cost_cents: 1299, all_services_uk_cost_cents: 699,
  };

  const planMap = new Map<string, DbPlanDefault>(
    ((planRows ?? []) as DbPlanDefault[]).map((r) => [r.plan, r])
  );
  return { settings, planMap };
}

function toGlobalRule(s: DbSettings): PriceRule {
  return {
    mode: s.global_mode as 'multiplier' | 'fixed' | 'markup',
    fixedSellCents: s.global_fixed_cents,
    multiplierBp: s.global_multiplier_bp,
    markupPercent: s.global_markup_percent,
    markupFlatCents: s.global_markup_flat_cents,
  };
}

function toPlanRule(d: DbPlanDefault): PriceRule {
  return {
    mode: d.mode as 'multiplier' | 'fixed' | 'markup',
    fixedSellCents: d.sell_cents,
    multiplierBp: d.multiplier_bp,
    markupPercent: d.markup_percent,
    markupFlatCents: d.markup_flat_cents,
  };
}

function computeSell(
  costCents: number,
  plan: PlanCode,
  override: number | undefined,
  planMap: Map<string, DbPlanDefault>,
  settings: DbSettings,
): number {
  const pd = planMap.get(plan);
  return resolvePrice({
    plan, costCents,
    explicitSellCents: override ?? null,
    planRule: pd ? toPlanRule(pd) : null,
    globalRule: toGlobalRule(settings),
    minMarginCents: settings.global_min_margin_cents ?? 1,
  }).sellCents;
}

function isUk(country: string): boolean {
  const c = country.toUpperCase();
  return c === 'UK' || c === 'GB' || c === 'UNITED KINGDOM';
}

function countryFlag(country: string): string {
  return isUk(country) ? '🇬🇧' : '🇺🇸';
}

// ─── Deduplicated service list ────────────────────────────────────────────────

type DedupeEntry = {
  name: string;
  usRow: SvcRow | null;
  ukRow: SvcRow | null;
};

function dedupeByName(rows: SvcRow[]): DedupeEntry[] {
  const map = new Map<string, DedupeEntry>();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    if (!map.has(key)) map.set(key, { name: r.name, usRow: null, ukRow: null });
    const entry = map.get(key)!;
    if (isUk(r.country)) entry.ukRow = r;
    else entry.usRow = r;
  }
  return Array.from(map.values());
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** Paginated service list — deduplicated US+UK entries. */
export async function handleServiceList(ctx: BotContext, page: number): Promise<void> {
  const offset = (page - 1) * PAGE_SIZE;

  const [{ data, error }, { settings, planMap }] = await Promise.all([
    ctx.db
      .from('services_cache')
      .select('short_id,service_id,name,country,str_cost_cents,str_stock,ltr_stock')
      .neq('name', 'ALL_SERVICES')
      .order('name')
      .range(offset, offset + PAGE_SIZE * 3), // fetch extra to handle duplicates
    loadPricingConfig(ctx),
  ]);

  if (error) {
    const msg = '❌ Could not load services. Please try again.';
    if (ctx.callbackQuery) await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
    else await ctx.reply(msg);
    return;
  }

  const deduped = dedupeByName((data ?? []) as SvcRow[]);
  const hasMore = deduped.length > PAGE_SIZE;
  const pageEntries = deduped.slice(0, PAGE_SIZE);

  if (pageEntries.length === 0) {
    await ctx.reply('No services available right now.');
    return;
  }

  const lines = pageEntries.map((e) => {
    const r = e.usRow ?? e.ukRow!;
    const inStock = r.str_stock > 0;
    const sell = inStock
      ? computeSell(r.str_cost_cents, 'STR', undefined, planMap, settings)
      : 0;
    const dual = e.usRow && e.ukRow ? ' 🇺🇸🇬🇧' : (e.ukRow ? ' 🇬🇧' : '');
    return `• <b>${esc(e.name)}</b>${dual} — ${inStock ? formatCents(sell) : 'N/A'}`;
  });

  const text = `📋 <b>Browse Numbers</b> (page ${page})\n${HR}\n` +
    lines.join('\n') + `\n\nTap a service to view plans & buy.`;

  // Build button list with the primary short_id for each entry
  const svcs = pageEntries.map((e) => ({
    shortId: (e.usRow ?? e.ukRow!).short_id,
    name: e.name,
  }));

  const kb = serviceListKb(svcs, page, hasMore);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

/**
 * Service view — entry point from list.
 * If the service has both US and UK variants → show country picker.
 * If single-country → show detail directly.
 */
export async function handleServiceView(ctx: BotContext, shortId: number): Promise<void> {
  if (shortId === 0) {
    const text = `🌐 <b>ALL_SERVICES Number</b>\n${HR}\nGet a random available number from any service.\n\n🇺🇸 US — 20-min STR\n🇬🇧 UK — 30-day LTR`;
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: allServicesKb() }).catch(() => undefined);
    return;
  }

  const { data: svc, error } = await ctx.db
    .from('services_cache')
    .select('name,country')
    .eq('short_id', shortId)
    .single();

  if (error || !svc) {
    await ctx.editMessageText('❌ Service not found.').catch(() => undefined);
    return;
  }

  // Check for sibling with same name but different country
  const { data: siblings } = await ctx.db
    .from('services_cache')
    .select('short_id,country')
    .eq('name', svc.name as string)
    .neq('short_id', shortId);

  const sibling = ((siblings ?? []) as { short_id: number; country: string }[])[0];

  if (sibling) {
    // Dual-country → show country picker
    const usShortId = isUk(svc.country as string) ? sibling.short_id : shortId;
    const ukShortId = isUk(svc.country as string) ? shortId : sibling.short_id;

    const text = `📶 <b>${esc(svc.name as string)}</b>\n${HR}\n\nThis service is available for both 🇺🇸 US and 🇬🇧 UK numbers.\nChoose a country:`;
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: countryPickKb(usShortId, ukShortId),
    }).catch(() => undefined);
    return;
  }

  // Single country → show detail directly
  await handleServiceDetail(ctx, shortId);
}

/**
 * Service detail — always shows the full plan/price screen.
 * Used after country picker OR for single-country services.
 */
export async function handleServiceDetail(ctx: BotContext, shortId: number): Promise<void> {
  const [{ data: svc, error }, { settings, planMap }] = await Promise.all([
    ctx.db.from('services_cache').select('*').eq('short_id', shortId).single(),
    loadPricingConfig(ctx),
  ]);

  if (error || !svc) {
    await ctx.editMessageText('❌ Service not found.').catch(() => undefined);
    return;
  }

  const { data: overrides } = await ctx.db
    .from('service_prices')
    .select('plan,sell_cents')
    .eq('service_id', svc.service_id as string)
    .is('tier_id', null);

  const ovMap = new Map(
    ((overrides ?? []) as { plan: string; sell_cents: number }[]).map((p) => [p.plan, p.sell_cents])
  );

  const s = svc as SvcRow;
  const flag = countryFlag(s.country);
  const strSell   = computeSell(s.str_cost_cents,   'STR',   ovMap.get('STR'),   planMap, settings);
  const ltr3Sell  = computeSell(s.ltr3_cost_cents,  'LTR3',  ovMap.get('LTR3'),  planMap, settings);
  const ltr7Sell  = computeSell(s.ltr7_cost_cents,  'LTR7',  ovMap.get('LTR7'),  planMap, settings);
  const ltr14Sell = computeSell(s.ltr14_cost_cents, 'LTR14', ovMap.get('LTR14'), planMap, settings);
  const ltr30Sell = computeSell(s.ltr30_cost_cents, 'LTR30', ovMap.get('LTR30'), planMap, settings);

  const strAvail = s.str_stock > 0;
  const ltrAvail = s.ltr_stock > 0;

  const lines: string[] = [
    `📶 <b>${esc(s.name)}</b>`,
    HR,
    `${flag} Country: <b>${esc(s.country)}</b>`,
    '',
    strAvail
      ? `⚡ STR 20-min: <b>${formatCents(strSell)}</b> (${s.str_stock} in stock)`
      : `⚡ STR 20-min: Out of stock`,
    '',
  ];

  if (ltrAvail) {
    lines.push(`📅 LTR Plans:`);
    if (s.ltr3_cost_cents > 0)  lines.push(`  3 days:  <b>${formatCents(ltr3Sell)}</b>`);
    if (s.ltr7_cost_cents > 0)  lines.push(`  7 days:  <b>${formatCents(ltr7Sell)}</b>`);
    if (s.ltr14_cost_cents > 0) lines.push(`  14 days: <b>${formatCents(ltr14Sell)}</b>`);
    if (s.ltr30_cost_cents > 0) lines.push(`  30 days: <b>${formatCents(ltr30Sell)}</b>`);
  } else {
    lines.push(`📅 LTR: Out of stock`);
  }

  const text = lines.join('\n');
  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: buyOptionsKb(shortId, ltrAvail),
  }).catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: buyOptionsKb(shortId, ltrAvail) }));
}

/** Search services by name — called by /search <query> command. */
export async function handleServiceSearch(ctx: BotContext, query: string): Promise<void> {
  const q = query.trim();
  if (!q) {
    await ctx.reply('❌ Please provide a search term.\nExample: <code>/search airbnb</code>', { parse_mode: 'HTML' });
    return;
  }

  const [{ data, error }, { settings, planMap }] = await Promise.all([
    ctx.db
      .from('services_cache')
      .select('short_id,service_id,name,country,str_cost_cents,str_stock,ltr_stock')
      .ilike('name', `%${q}%`)
      .neq('name', 'ALL_SERVICES')
      .order('name')
      .limit(50),
    loadPricingConfig(ctx),
  ]);

  if (error || !data || data.length === 0) {
    await ctx.reply(`🔍 No services found matching "<b>${esc(q)}</b>".`, { parse_mode: 'HTML' });
    return;
  }

  const deduped = dedupeByName(data as SvcRow[]);
  const topResults = deduped.slice(0, PAGE_SIZE);

  const lines = topResults.map((e) => {
    const r = e.usRow ?? e.ukRow!;
    const inStock = r.str_stock > 0;
    const sell = inStock ? computeSell(r.str_cost_cents, 'STR', undefined, planMap, settings) : 0;
    const dual = e.usRow && e.ukRow ? ' 🇺🇸🇬🇧' : (e.ukRow ? ' 🇬🇧' : '');
    return `• <b>${esc(e.name)}</b>${dual} — ${inStock ? formatCents(sell) : 'N/A'}`;
  });

  const text = `🔍 <b>Search: "${esc(q)}"</b>\n${HR}\n` +
    lines.join('\n') +
    (deduped.length > PAGE_SIZE ? `\n\n<i>Showing ${PAGE_SIZE} of ${deduped.length} results. Refine your search to narrow down.</i>` : '');

  const svcs = topResults.map((e) => ({
    shortId: (e.usRow ?? e.ukRow!).short_id,
    name: e.name,
  }));

  const { InlineKeyboard } = await import('grammy');
  const kb = new InlineKeyboard();
  for (const s of svcs) {
    // ✅ Use cb() with colon separator (NOT raw comma string)
    kb.text(s.name.slice(0, 30), cb('SVC_VIEW', s.shortId)).row();
  }
  kb.text('🔍 Search Again', cb('SVC_SRCH')).text('🔙 Home', cb('HOME')).row();

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}
