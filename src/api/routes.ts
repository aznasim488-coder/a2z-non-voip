/**
 * REST API routes for the A2Z website frontend.
 * Auth: Supabase JWT in Authorization header.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import type { PvaDealsClient } from '../upstream/client.js';
import type { Env } from '../config/env.js';
import { creditWallet, debitWallet, InsufficientFundsError } from '../domain/wallet.js';
import { resolvePrice, type PlanCode, type PriceRule, type PricingContext } from '../domain/pricing.js';
import { formatCents } from '../domain/money.js';
import { createInvoice, MIN_TOPUP_CENTS } from '../payments/nowpayments.js';

// ── Auth helper ───────────────────────────────────────────────────

async function auth(req: FastifyRequest, reply: FastifyReply, db: SupabaseClient, env: Env) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) { reply.code(401).send({ error: 'No token' }); return null; }
  const token = h.slice(7);
  const uc = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error } = await uc.auth.getUser(token);
  if (error || !user) { reply.code(401).send({ error: 'Invalid token' }); return null; }
  const { data: p } = await db.from('profiles').select('id, telegram_id, username, first_name').eq('auth_user_id', user.id).maybeSingle();
  if (!p) { reply.code(404).send({ error: 'Profile not found' }); return null; }
  return p as any as { id: string; telegram_id: number | null; username: string | null; first_name: string };
}

// ── Pricing helper ────────────────────────────────────────────────

async function pricing(db: SupabaseClient, plan: PlanCode, costCents: number, svcId?: string): Promise<PricingContext> {
  let explicitSellCents: number | null = null;
  if (svcId) {
    const { data: sp } = await db.from('service_prices').select('sell_cents').eq('service_id', svcId).eq('plan', plan).maybeSingle();
    if (sp) explicitSellCents = (sp as any).sell_cents;
  }
  const { data: pd } = await db.from('plan_defaults').select('mode, fixed_sell_cents, multiplier_bp, markup_percent, markup_flat_cents').eq('plan', plan).maybeSingle();
  const planRule: PriceRule | null = pd ? { mode: (pd as any).mode, fixedSellCents: (pd as any).fixed_sell_cents, multiplierBp: (pd as any).multiplier_bp, markupPercent: (pd as any).markup_percent, markupFlatCents: (pd as any).markup_flat_cents } : null;
  const { data: settings } = await db.from('settings').select('global_mode, global_multiplier_bp, global_markup_percent, global_markup_flat_cents, global_fixed_sell_cents, global_min_margin_cents').single();
  const s = settings as any;
  return { plan, costCents, explicitSellCents, planRule, globalRule: { mode: s?.global_mode ?? 'multiplier', fixedSellCents: s?.global_fixed_sell_cents ?? null, multiplierBp: s?.global_multiplier_bp ?? 20000, markupPercent: s?.global_markup_percent ?? null, markupFlatCents: s?.global_markup_flat_cents ?? null }, minMarginCents: s?.global_min_margin_cents ?? 10 };
}

// ── Register routes ───────────────────────────────────────────────

export function registerApiRoutes(app: FastifyInstance, db: SupabaseClient, pva: PvaDealsClient, env: Env): void {

  // GET /api/me
  app.get('/api/me', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { data: w } = await db.from('wallets').select('balance_cents').eq('user_id', u.id).maybeSingle();
    const { data: tops } = await db.from('topups').select('amount_cents, status, created_at, method').eq('user_id', u.id).order('created_at', { ascending: false }).limit(5);
    return { profile: u, balance_cents: (w as any)?.balance_cents ?? 0, recent_topups: tops ?? [] };
  });

  // GET /api/services
  app.get('/api/services', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { data: catalog } = await db.from('catalog').select('*').order('name');
    if (!catalog) return { services: [] };
    const result = [];
    for (const svc of catalog) {
      const s = svc as any;
      const plans: Record<string, { costCents: number; sellCents: number }> = {};
      for (const [plan, field] of [['STR','str_cost_cents'],['LTR3','ltr3_cost_cents'],['LTR7','ltr7_cost_cents'],['LTR14','ltr14_cost_cents'],['LTR30','ltr30_cost_cents']] as const) {
        const c = s[field] ?? 0; if (c <= 0) continue;
        const ctx = await pricing(db, plan, c, s.service_id);
        plans[plan] = { costCents: c, sellCents: resolvePrice(ctx).sellCents };
      }
      result.push({ service_id: s.service_id, name: s.name, country: s.country, str_stock: s.str_stock ?? 0, ltr_stock: s.ltr_stock ?? 0, plans });
    }
    return { services: result };
  });

  // GET /api/services/:id
  app.get('/api/services/:id', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { id } = req.params as { id: string };
    const { data: svc } = await db.from('catalog').select('*').eq('service_id', id).maybeSingle();
    if (!svc) return reply.code(404).send({ error: 'Not found' });
    const s = svc as any;
    const plans: Record<string, { costCents: number; sellCents: number }> = {};
    for (const [plan, field] of [['STR','str_cost_cents'],['LTR3','ltr3_cost_cents'],['LTR7','ltr7_cost_cents'],['LTR14','ltr14_cost_cents'],['LTR30','ltr30_cost_cents']] as const) {
      const c = s[field] ?? 0; if (c <= 0) continue;
      plans[plan] = { costCents: c, sellCents: resolvePrice(await pricing(db, plan, c, s.service_id)).sellCents };
    }
    return { service_id: s.service_id, name: s.name, country: s.country, str_stock: s.str_stock ?? 0, ltr_stock: s.ltr_stock ?? 0, plans };
  });

  // POST /api/buy
  app.post('/api/buy', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { service_id, plan } = req.body as any;
    if (!service_id || !plan) return reply.code(400).send({ error: 'Missing fields' });
    const { data: svc } = await db.from('catalog').select('*').eq('service_id', service_id).maybeSingle();
    if (!svc) return reply.code(404).send({ error: 'Not found' });
    const s = svc as any;
    const costMap: Record<string,string> = { STR:'str_cost_cents', LTR3:'ltr3_cost_cents', LTR7:'ltr7_cost_cents', LTR14:'ltr14_cost_cents', LTR30:'ltr30_cost_cents' };
    const costCents = s[costMap[plan]] ?? 0;
    const price = resolvePrice(await pricing(db, plan as PlanCode, costCents, service_id));
    const idempKey = `web_${u.id}_${service_id}_${plan}_${Date.now()}`;
    try {
      await debitWallet(db, { userId: u.id, amountCents: price.sellCents, kind: 'purchase', idempotencyKey: idempKey, note: `${s.name} ${plan} via web` });
    } catch (e) {
      if (e instanceof InsufficientFundsError) return reply.code(402).send({ error: 'Insufficient balance' });
      throw e;
    }
    try {
      let r; if (plan === 'STR') r = await pva.purchaseStr(service_id);
      else { const d = parseInt(plan.replace('LTR','')) as 3|7|14|30; r = await pva.purchaseLtr(service_id, d); }
      await db.from('orders').insert({ user_id: u.id, service_id, service_name: s.name, plan, request_id: r!.requestId, number: r!.number, status: r!.status, end_time: r!.endTime, cost_cents: costCents, sell_cents: price.sellCents, country: r!.country } as any);
      return { success: true, number: r!.number, request_id: r!.requestId, plan, sell_cents: price.sellCents, end_time: r!.endTime };
    } catch (e) {
      await creditWallet(db, { userId: u.id, amountCents: price.sellCents, kind: 'refund', idempotencyKey: `refund_${idempKey}`, note: `Refund: ${s.name} ${plan} failed` });
      return reply.code(500).send({ error: 'Purchase failed. Wallet refunded.' });
    }
  });

  // GET /api/orders
  app.get('/api/orders', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { data: orders } = await db.from('orders').select('id, service_name, plan, number, status, end_time, sell_cents, country, request_id, created_at').eq('user_id', u.id).order('created_at', { ascending: false }).limit(50);
    return { orders: orders ?? [] };
  });

  // GET /api/orders/:id/sms
  app.get('/api/orders/:id/sms', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { id } = req.params as { id: string };
    const { data: msgs } = await db.from('sms_messages').select('body, created_at').eq('order_id', id).eq('user_id', u.id).order('created_at', { ascending: false });
    return { messages: msgs ?? [] };
  });

  // POST /api/topup/bkash
  app.post('/api/topup/bkash', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { trx_id, amount_tk } = req.body as any;
    if (!trx_id || !amount_tk) return reply.code(400).send({ error: 'Missing fields' });
    const { data: st } = await db.from('settings').select('bkash_rate_tk, bkash_min_tk, bkash_enabled').maybeSingle();
    const ss = st as any;
    if (!ss?.bkash_enabled) return reply.code(400).send({ error: 'bKash disabled' });
    if (amount_tk < (ss.bkash_min_tk ?? 390)) return reply.code(400).send({ error: `Min ${ss.bkash_min_tk} TK` });
    const cents = Math.round((amount_tk / (ss.bkash_rate_tk ?? 130)) * 100);
    const { data: dup } = await db.from('ledger_entries').select('id').eq('idempotency_key', `bkash_${trx_id}`).maybeSingle();
    if (dup) return reply.code(409).send({ error: 'Duplicate TrxID' });
    await db.from('topups').insert({ user_id: u.id, amount_cents: cents, method: 'bkash' as any, status: 'pending', external_id: trx_id, note: `${amount_tk} TK web` } as any);
    return { success: true, amount_tk, amount_usd: (cents/100).toFixed(2), status: 'pending', message: 'Admin will verify shortly.' };
  });

  // POST /api/topup/nagad
  app.post('/api/topup/nagad', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { trx_id, amount_tk } = req.body as any;
    if (!trx_id || !amount_tk) return reply.code(400).send({ error: 'Missing fields' });
    const { data: st } = await db.from('settings').select('nagad_rate_tk, nagad_min_tk, nagad_enabled').maybeSingle();
    const ss = st as any;
    if (!ss?.nagad_enabled) return reply.code(400).send({ error: 'Nagad disabled' });
    if (amount_tk < (ss.nagad_min_tk ?? 390)) return reply.code(400).send({ error: `Min ${ss.nagad_min_tk} TK` });
    const cents = Math.round((amount_tk / (ss.nagad_rate_tk ?? 130)) * 100);
    const { data: dup } = await db.from('ledger_entries').select('id').eq('idempotency_key', `nagad_${trx_id}`).maybeSingle();
    if (dup) return reply.code(409).send({ error: 'Duplicate TrxID' });
    await db.from('topups').insert({ user_id: u.id, amount_cents: cents, method: 'nagad' as any, status: 'pending', external_id: trx_id, note: `${amount_tk} TK web` } as any);
    return { success: true, amount_tk, amount_usd: (cents/100).toFixed(2), status: 'pending', message: 'Admin will verify shortly.' };
  });

  // POST /api/topup/crypto
  app.post('/api/topup/crypto', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { amount_usd } = req.body as any;
    const { data: paySettings } = await db.from('settings').select('min_topup_cents').maybeSingle();
    const minTopupCents = (paySettings as any)?.min_topup_cents ?? 300;
    if (!amount_usd || amount_usd < minTopupCents / 100) return reply.code(400).send({ error: 'Amount too low' });
    try {
      const amountCents = Math.round(amount_usd * 100);
      const ipnUrl = `${env.PVADEALS_BASE_URL?.replace('/v3', '') || 'https://your-app.up.railway.app'}/webhooks/nowpayments`;
      const inv = await createInvoice({ apiKey: env.NOWPAYMENTS_API_KEY!, amountUsd: amount_usd, userId: u.id, amountCents, ipnCallbackUrl: ipnUrl });
      return { success: true, invoice_url: inv.invoice_url, invoice_id: inv.id };
    }
    catch { return reply.code(500).send({ error: 'Invoice creation failed' }); }
  });

  // GET /api/payment-settings
  app.get('/api/payment-settings', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const { data: d } = await db.from('settings').select('bkash_number, bkash_rate_tk, bkash_min_tk, bkash_enabled, nagad_number, nagad_rate_tk, nagad_min_tk, nagad_enabled').maybeSingle();
    const s = d as any;
    return { bkash: { enabled: s?.bkash_enabled??false, number: s?.bkash_number??'', rate_tk: s?.bkash_rate_tk??130, min_tk: s?.bkash_min_tk??390 }, nagad: { enabled: s?.nagad_enabled??false, number: s?.nagad_number??'', rate_tk: s?.nagad_rate_tk??130, min_tk: s?.nagad_min_tk??390 }, crypto_enabled: !!env.NOWPAYMENTS_API_KEY };
  });

  // POST /api/link-telegram
  app.post('/api/link-telegram', async (req, reply) => {
    const u = await auth(req, reply, db, env); if (!u) return;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    await (db.from('profiles') as any).update({ link_code: code, link_code_expires: expires }).eq('id', u.id);
    return { code, expires_in_seconds: 600, instructions: `Send /link ${code} to the bot.` };
  });

  app.log.info('[api] Website REST routes registered');
}
