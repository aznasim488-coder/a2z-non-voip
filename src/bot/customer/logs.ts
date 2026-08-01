/**
 * Logs screens — SMS Logs, Number Logs (ledger), Payment Logs (topups).
 */

import type { BotContext } from '../middleware.js';
import { esc, HR } from '../ui/format.js';
import { formatCents } from '../../domain/money.js';
import { cb } from '../ui/codec.js';
import { InlineKeyboard } from 'grammy';

const PAGE_SIZE = 8;

// ─── Logs menu ────────────────────────────────────────────────────────────────

export async function handleLogsMenu(ctx: BotContext): Promise<void> {
  const text = `📊 <b>Account Logs</b>\n${HR}\nChoose a log type to view:`;
  const kb = new InlineKeyboard()
    .text('📨 SMS Logs', cb('LOG_SMS', 1)).row()
    .text('📋 Number Logs', cb('LOG_NUM', 1)).row()
    .text('💳 Payment Logs', cb('LOG_PAY', 1)).row()
    .text('🏠 Home', cb('HOME'));

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// ─── SMS Logs ─────────────────────────────────────────────────────────────────

export async function handleSmsLogs(ctx: BotContext, page: number): Promise<void> {
  const offset = (page - 1) * PAGE_SIZE;

  const { data, error } = await ctx.db
    .from('sms_messages')
    .select('id,request_id,number,body,received_at,orders(service_name)')
    .eq('user_id', ctx.user.id)
    .order('received_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE);

  if (error) {
    const msg = '❌ Could not load SMS logs.';
    if (ctx.callbackQuery) await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
    else await ctx.reply(msg);
    return;
  }

  const rows = data ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);

  if (pageRows.length === 0) {
    const msg = page === 1
      ? `📨 <b>SMS Logs</b>\n${HR}\nNo SMS messages yet.\n\nSMS codes will appear here when received.`
      : `📨 <b>SMS Logs</b>\n${HR}\nNo more messages.`;
    const kb = new InlineKeyboard()
      .text('🔙 Logs', cb('LOG_MENU')).text('🏠 Home', cb('HOME'));
    if (ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: kb }).catch(() => ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb }));
    else await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  const lines = pageRows.map((r: any) => {
    const svc = r.orders?.service_name ?? '?';
    const num = r.number ?? '?';
    const date = new Date(r.received_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    // Trim body to 60 chars for the list
    const body = (r.body as string).slice(0, 60) + ((r.body as string).length > 60 ? '…' : '');
    return `📨 <b>${esc(svc)}</b> — <code>${esc(num)}</code>\n<i>${date}</i>: ${esc(body)}`;
  });

  const text = `📨 <b>SMS Logs</b> (page ${page})\n${HR}\n` + lines.join('\n\n');

  const kb = new InlineKeyboard();
  if (page > 1) kb.text('◀ Prev', cb('LOG_SMS', page - 1));
  if (hasMore) kb.text('Next ▶', cb('LOG_SMS', page + 1));
  if (page > 1 || hasMore) kb.row();
  kb.text('🔙 Logs', cb('LOG_MENU')).text('🏠 Home', cb('HOME'));

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// ─── Number Logs (ledger) ─────────────────────────────────────────────────────

export async function handleNumberLogs(ctx: BotContext, page: number): Promise<void> {
  const offset = (page - 1) * PAGE_SIZE;

  const { data, error } = await ctx.db
    .from('ledger_entries')
    .select('id,kind,amount_cents,balance_after,note,created_at,orders(number,service_name,plan)')
    .eq('user_id', ctx.user.id)
    .in('kind', ['purchase', 'reuse', 'refund'])
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE);

  if (error) {
    const msg = '❌ Could not load number logs.';
    if (ctx.callbackQuery) await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
    else await ctx.reply(msg);
    return;
  }

  const rows = data ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);

  if (pageRows.length === 0) {
    const msg = page === 1
      ? `📋 <b>Number Logs</b>\n${HR}\nNo transactions yet.`
      : `📋 <b>Number Logs</b>\n${HR}\nNo more entries.`;
    const kb = new InlineKeyboard()
      .text('🔙 Logs', cb('LOG_MENU')).text('🏠 Home', cb('HOME'));
    if (ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: kb }).catch(() => ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb }));
    else await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  const kindEmoji: Record<string, string> = {
    purchase: '💸',
    reuse:    '🔄',
    refund:   '↩️',
  };

  const lines = pageRows.map((r: any) => {
    const emoji = kindEmoji[r.kind] ?? '•';
    const sign = r.kind === 'refund' ? '+' : '-';
    const amount = formatCents(Math.abs(r.amount_cents as number));
    const after = formatCents(r.balance_after as number);
    const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const svc = r.orders?.service_name ?? '';
    const num = r.orders?.number ?? '';
    const plan = r.orders?.plan ?? '';
    const detail = svc ? ` — ${esc(svc)}${plan ? ` [${plan}]` : ''}` : (r.note ? ` ${esc(r.note)}` : '');
    return `${emoji} <b>${sign}${amount}</b>${detail}\n   <code>${num}</code>  <i>${date}</i>  bal: ${after}`;
  });

  const text = `📋 <b>Number Logs</b> (page ${page})\n${HR}\n` + lines.join('\n\n');

  const kb = new InlineKeyboard();
  if (page > 1) kb.text('◀ Prev', cb('LOG_NUM', page - 1));
  if (hasMore) kb.text('Next ▶', cb('LOG_NUM', page + 1));
  if (page > 1 || hasMore) kb.row();
  kb.text('🔙 Logs', cb('LOG_MENU')).text('🏠 Home', cb('HOME'));

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// ─── Payment Logs (top-ups) ───────────────────────────────────────────────────

export async function handlePaymentLogs(ctx: BotContext, page: number): Promise<void> {
  const offset = (page - 1) * PAGE_SIZE;

  // Topups table + admin credits from ledger
  const { data: topupRows, error: topupErr } = await ctx.db
    .from('topups')
    .select('id,amount_cents,method,status,note,created_at')
    .eq('user_id', ctx.user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE);

  if (topupErr) {
    const msg = '❌ Could not load payment logs.';
    if (ctx.callbackQuery) await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
    else await ctx.reply(msg);
    return;
  }

  const rows = topupRows ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);

  if (pageRows.length === 0) {
    const msg = page === 1
      ? `💳 <b>Payment Logs</b>\n${HR}\nNo payments yet.\n\nUse the Wallet to add funds.`
      : `💳 <b>Payment Logs</b>\n${HR}\nNo more payments.`;
    const kb = new InlineKeyboard()
      .text('🔙 Logs', cb('LOG_MENU')).text('🏠 Home', cb('HOME'));
    if (ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: kb }).catch(() => ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb }));
    else await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  const statusEmoji: Record<string, string> = {
    confirmed: '✅',
    pending:   '⏳',
    failed:    '❌',
  };

  const methodLabel: Record<string, string> = {
    admin:        'Admin Credit',
    nowpayments:  'Crypto',
    voucher:      'Voucher',
  };

  const lines = pageRows.map((r: any) => {
    const emoji = statusEmoji[r.status] ?? '•';
    const amount = formatCents(r.amount_cents as number);
    const method = methodLabel[r.method] ?? r.method;
    const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const note = r.note ? ` — <i>${esc(r.note)}</i>` : '';
    return `${emoji} <b>+${amount}</b> via ${method}${note}\n   <i>${date}</i> — ${r.status}`;
  });

  const text = `💳 <b>Payment Logs</b> (page ${page})\n${HR}\n` + lines.join('\n\n');

  const kb = new InlineKeyboard();
  if (page > 1) kb.text('◀ Prev', cb('LOG_PAY', page - 1));
  if (hasMore) kb.text('Next ▶', cb('LOG_PAY', page + 1));
  if (page > 1 || hasMore) kb.row();
  kb.text('🔙 Logs', cb('LOG_MENU')).text('🏠 Home', cb('HOME'));

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}
