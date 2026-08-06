import type { BotContext } from '../middleware.js';
import { numberActionsKb, myNumbersNavKb } from '../ui/keyboards.js';
import { esc, HR, phoneBlock, expiryLine } from '../ui/format.js';
import { shortReqId, cb } from '../ui/codec.js';

const PAGE_SIZE = 5;

/** Show list of user's active numbers. */
export async function handleMyNumbers(ctx: BotContext, page: number): Promise<void> {
  const offset = (page - 1) * PAGE_SIZE;

  const { data: orders, error } = await ctx.db
    .from('orders')
    .select('id,service_name,plan,number,status,end_time,request_id')
    .eq('user_id', ctx.user.id)
    .in('status', ['RESERVED', 'COMPLETED'])
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE);


  if (error) {
    await ctx.reply('❌ Could not load numbers. Please try again.');
    return;
  }

  const rows = orders ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);

  if (pageRows.length === 0) {
    const text = page === 1
      ? '📭 You have no active numbers.\n\nUse <b>Browse Numbers</b> to buy one.'
      : '📭 No more numbers.';
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: myNumbersNavKb(page, false),
    }).catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: myNumbersNavKb(page, false) }));
    return;
  }

  const lines = pageRows.map((r, i) =>
    `${offset + i + 1}. <code>${esc(r.number ?? '?')}</code> — ${esc(r.service_name)} [${r.plan}] — ${r.status}`,
  );

  const text =
    `📱 <b>My Numbers</b> (page ${page})\n${HR}\n` +
    lines.join('\n') +
    '\n\nTap a number to see actions.';

  // Add per-number view buttons
  const { InlineKeyboard } = await import('grammy');
  const kb = new InlineKeyboard();
  for (const r of pageRows) {
    kb.text(`📱 ${r.number ?? '?'}`, cb('NUM_VIEW', shortReqId(r.request_id ?? ''))).row();
  }
  if (page > 1) kb.text('◀ Prev', cb('NUM_LIST', page - 1));
  if (hasMore) kb.text('Next ▶', cb('NUM_LIST', page + 1));
  if (page > 1 || hasMore) kb.row();
  kb.text('🏠 Home', cb('HOME'));

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() =>
    ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }),
  );
}

/** Show detail + actions for one number. */
export async function handleNumberView(ctx: BotContext, shortRequestId: string): Promise<void> {
  const { data: order, error } = await ctx.db
    .from('orders')
    .select('*')
    .eq('user_id', ctx.user.id)
    .like('request_id', `${shortRequestId}%`)
    .single();

  if (error || !order) {
    const msg = '❌ Number not found.';
    await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
    return;
  }

  const requestId    = order.request_id as string;
  const isReserved   = (order.status as string) === 'RESERVED';
  const isCompleted  = (order.status as string) === 'COMPLETED';
  const isLtr        = (order.plan as string) !== 'STR';
  const planStr      = (order.plan as string);

  // Check if the number is expired (end_time in the past)
  const endTime  = order.end_time ? new Date(order.end_time as string) : null;
  const isExpired = endTime ? endTime < new Date() : false;

  // Duration from plan code
  const durationMap: Record<string, number> = { LTR3: 3, LTR7: 7, LTR14: 14, LTR30: 30 };
  let currentDuration = durationMap[planStr] ?? 3;
  let autoRenew       = (order as any).auto_renew as boolean ?? false;

  // ── Flag rules (same for STR and LTR) ───────────────────────────────────────
  //   RESERVED  = no OTP yet → flag IS allowed
  //   COMPLETED = OTP arrived → flag NOT allowed
  //   EXPIRED   = past end_time → flag NOT allowed
  //   REUSED    = if reuse_count > 0, it means it already got a code previously → flag NOT allowed
  const reuseCount = (order as any).reuse_count as number ?? 0;
  
  let allowFlag    = isReserved && !isExpired && reuseCount === 0;
  let allowReuse   = isCompleted && !isExpired;
  // LTR-only actions (only while still active)
  let canRenew     = isLtr && !isExpired;
  let canChangeDur = isLtr && !isExpired;

  if (!isExpired) {
    try {
      const req = await ctx.pva.getRequest(requestId);
      // For COMPLETED numbers, respect upstream allowFlag (usually false)
      if (!isReserved) allowFlag = req.allowFlag && !isExpired && reuseCount === 0;
      allowReuse   = req.allowReuse && !isExpired;
      canRenew     = req.numberType === 'LTR' && !isExpired;
      canChangeDur = req.numberType === 'LTR' && !isExpired;
      autoRenew    = req.autoRenewEnable ?? autoRenew;
      if (req.duration) currentDuration = req.duration;
    } catch {
      // Upstream unreachable — keep defaults
    }
  }

  const typeLabel = isLtr ? `LTR-${currentDuration}d` : 'STR 20-min';
  const arStatus  = autoRenew ? '🟢 ON' : '🔴 OFF';

  // ── Expired number — simplified view ────────────────────────────────────────
  if (isExpired) {
    const smsRows = await fetchSmsForOrder(ctx, order.id as string);
    const lines = [
      `📱 <b>Number Details</b>`,
      HR,
      phoneBlock(order.number as string),
      `Service: <b>${esc(order.service_name as string)}</b>`,
      `Plan: <b>${typeLabel}</b>`,
      `Status: <b>⏰ EXPIRED</b>`,
      expiryLine(order.end_time as string),
      ...smsSection(smsRows),
      ``,
      `This number has expired. To use this service again, purchase a new number from Browse.`,
    ];
    const kb = new (await import('grammy')).InlineKeyboard()
      .text('📋 Browse Numbers', cb('SVC_LIST', 1)).row()
      .text('🏠 Home', cb('HOME'));
    const text = lines.join('\n');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
    return;
  }

  // ── Active number ────────────────────────────────────────────────────────────
  const smsRows = await fetchSmsForOrder(ctx, order.id as string);

  const lines = [
    `📱 <b>Number Details</b>`,
    HR,
    phoneBlock(order.number as string),
    `Service: <b>${esc(order.service_name as string)}</b>`,
    `Plan: <b>${typeLabel}</b>`,
    `Status: <b>${order.status}</b>`,
    expiryLine(order.end_time as string),
    ...smsSection(smsRows),
  ];
  if (isLtr) lines.push(`Auto Renew: <b>${arStatus}</b>`);

  const text = lines.join('\n');
  const kb = numberActionsKb(requestId, {
    canFlag: allowFlag,
    canReuse: allowReuse,
    canRenew,
    canChangeDur,
    autoRenew,
    currentDuration,
  });

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fetch last 3 SMS messages for an order (newest first). */
async function fetchSmsForOrder(
  ctx: BotContext,
  orderId: string,
): Promise<{ body: string; received_at: string }[]> {
  const { data } = await ctx.db
    .from('sms_messages')
    .select('body,received_at')
    .eq('order_id', orderId)
    .order('received_at', { ascending: false })
    .limit(3);
  return (data ?? []) as { body: string; received_at: string }[];
}

/** Format SMS rows into message lines with OTP highlight. */
function smsSection(rows: { body: string; received_at: string }[]): string[] {
  if (rows.length === 0) return ['\n⏳ <i>Waiting for OTP…</i>'];

  const lines: string[] = ['\n📨 <b>Received OTP(s):</b>'];
  for (const row of rows) {
    const otp = row.body.match(/\b(\d{4,8})\b/)?.[1] ?? null;
    const time = new Date(row.received_at).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
    if (otp) {
      lines.push(`🔑 Code: <code>${otp}</code> <i>(${time})</i>`);
    }
    lines.push(`<i>${esc(row.body)}</i>`);
  }
  return lines;
}

