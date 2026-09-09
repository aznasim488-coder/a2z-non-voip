import type { BotContext } from '../middleware.js';
import { numberActionsKb, myNumbersNavKb } from '../ui/keyboards.js';
import { esc, HR, phoneBlock, expiryLine } from '../ui/format.js';
import { shortReqId, cb } from '../ui/codec.js';
import { lookupPhone } from '../../upstream/ipqs.js';

// Hardcoded IPQS API key — also settable via IPQS_API_KEY env var
const IPQS_API_KEY = 'ZhfWsEATNOyUAgLFaMaH14vlvYPLHsZ4';

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
  const isDbExpired  = (order.status as string) === 'EXPIRED';
  const isLtr        = (order.plan as string) !== 'STR';
  const planStr      = (order.plan as string);

  // Check timestamp expiration
  const endTime       = order.end_time ? new Date(order.end_time as string) : null;
  const isPastEndTime = endTime ? endTime < new Date() : false;

  // LTR expires when the rental end_time passes or status is EXPIRED
  const isLtrExpired  = isLtr && (isDbExpired || isPastEndTime);

  // STR:
  // - If DB status is EXPIRED: expired without OTP & refunded
  // - If RESERVED and past end_time: initial window expired without OTP
  // - If COMPLETED: NOT expired! Completed STR numbers can be reused anytime for $0.80.
  const isStrExpired  = !isLtr && (isDbExpired || (isReserved && isPastEndTime));

  // Duration from plan code
  const durationMap: Record<string, number> = { LTR3: 3, LTR7: 7, LTR14: 14, LTR30: 30 };
  let currentDuration = durationMap[planStr] ?? 3;
  let autoRenew       = (order as any).auto_renew as boolean ?? false;
  const reuseCount    = (order as any).reuse_count as number ?? 0;

  // Defaults before upstream query
  let allowFlag    = isReserved && !isPastEndTime && reuseCount === 0;
  let allowReuse   = isLtr ? (isCompleted && !isLtrExpired) : isCompleted;
  let canRenew     = isLtr && !isLtrExpired;
  let canChangeDur = isLtr && !isLtrExpired;

  // Query upstream PVA deals for live status and action flags
  // We query upstream whenever the order is not dead (i.e. not LTR expired or STR reservation expired)
  let upstreamReuseDisallowed = false;
  if (!isLtrExpired && !isStrExpired) {
    try {
      const req = await ctx.pva.getRequest(requestId);
      if (isReserved) {
        allowFlag = req.allowFlag && !isPastEndTime && reuseCount === 0;
      } else {
        allowFlag = false;
      }

      if (isLtr) {
        allowReuse   = req.allowReuse && !isLtrExpired;
        canRenew     = req.numberType === 'LTR' && !isLtrExpired;
        canChangeDur = req.numberType === 'LTR' && !isLtrExpired;
      } else {
        // For STR: upstream allowReuse determines if reuse is allowed
        allowReuse = req.allowReuse;
        if (req.allowReuse === false) {
          upstreamReuseDisallowed = true;
        }
      }

      autoRenew = req.autoRenewEnable ?? autoRenew;
      if (req.duration) currentDuration = req.duration;
    } catch {
      // Upstream unreachable — keep defaults
    }
  }

  const typeLabel = isLtr ? `LTR-${currentDuration}d` : 'STR 20-min';
  const arStatus  = autoRenew ? '🟢 ON' : '🔴 OFF';

  // Determine if the number is truly dead and should show the simplified expired view:
  // - LTR past rental period
  // - STR never received OTP and reservation timed out
  // - STR completed, but upstream explicitly declared allowReuse: false
  const showExpiredView = isLtrExpired || isStrExpired || (!isLtr && isCompleted && upstreamReuseDisallowed);

  // ── Expired number — simplified view ────────────────────────────────────────
  if (showExpiredView) {
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

  // ── Active / Reusable number ──────────────────────────────────────────────────
  const smsRows = await fetchSmsForOrder(ctx, order.id as string);

  // Expiry / window info line
  let windowLine = '';
  if (order.end_time) {
    if (!isLtr && isCompleted) {
      if (isPastEndTime) {
        windowLine = allowReuse
          ? `⏱ OTP Window: <b>Finished</b> (🔄 <i>Reuse available anytime</i>)`
          : `⏱ OTP Window: <b>Finished</b>`;
      } else {
        windowLine = expiryLine(order.end_time as string);
      }
    } else {
      windowLine = expiryLine(order.end_time as string);
    }
  }

  const lines = [
    `📱 <b>Number Details</b>`,
    HR,
    phoneBlock(order.number as string),
    `Service: <b>${esc(order.service_name as string)}</b>`,
    `Plan: <b>${typeLabel}</b>`,
    `Status: <b>${order.status}</b>`,
  ];
  if (windowLine) lines.push(windowLine);
  lines.push(...smsSection(smsRows));
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

// ── IPQS Phone Details ────────────────────────────────────────────────────────

/** Format a boolean value with coloured emoji. */
function boolLine(value: boolean | null, trueLabel = 'true', falseLabel = 'false'): string {
  if (value === null || value === undefined) return 'N/A';
  return value ? `<b>${trueLabel}</b>` : falseLabel;
}

/**
 * Handle the "🔍 Check Number Details" button.
 * Looks up the phone number associated with the given shortRequestId and
 * calls the IPQS API. Only shown on the first-purchase success message.
 */
export async function handleIpqsLookup(ctx: BotContext, shortRequestId: string): Promise<void> {
  const apiKey = ctx.env.IPQS_API_KEY ?? IPQS_API_KEY;

  // Resolve the phone number from the DB
  const { data: order, error } = await ctx.db
    .from('orders')
    .select('number, request_id')
    .eq('user_id', ctx.user.id)
    .like('request_id', `${shortRequestId}%`)
    .single();

  if (error || !order || !(order as any).number) {
    await ctx.reply('❌ Could not find the number. Please try again.');
    return;
  }

  const phone = (order as any).number as string;

  // Show loading state
  const loadingMsg = await ctx.reply('🔍 Looking up number details, please wait…');

  try {
    const d = await lookupPhone(apiKey, phone);

    // Country flag emoji helper
    const flagEmoji = (cc: string): string => {
      if (!cc || cc === 'N/A' || cc.length !== 2) return '';
      const offset = 127397; // 🇦 starts at 0x1F1E6
      return Array.from(cc.toUpperCase())
        .map(c => String.fromCodePoint(c.codePointAt(0)! + offset))
        .join('');
    };

    const riskEmoji = (score: number): string => {
      if (score >= 90) return '🔴';
      if (score >= 75) return '🟡';
      return '🟢';
    };

    const lines = [
      `🔍 <b>Phone Number Details</b>`,
      HR,
      `📞 Formatted: <code>${esc(d.formatted)}</code>`,
      `📱 Local Format: <code>${esc(d.local_format)}</code>`,
      ``,
      `✅ Valid: ${boolLine(d.valid, 'true', 'false')}`,
      `✅ Active: ${boolLine(d.active, 'true', 'false')}`,
      `${riskEmoji(d.fraud_score)} Fraud Score: <b>${d.fraud_score}</b>`,
      `⚠️ Recent Abuse: ${boolLine(d.recent_abuse, '⚠️ YES', 'false')}`,
      `📡 VOIP: ${boolLine(d.VOIP, '⚠️ YES', 'false')}`,
      `💳 Prepaid: ${boolLine(d.prepaid, '⚠️ YES', 'false')}`,
      `⚡ Risky: ${boolLine(d.risky, '⚠️ YES', 'false')}`,
      `🔒 Leaked Online: ${boolLine(d.leaked, '⚠️ YES', 'false')}`,
      `📢 Spammer: ${boolLine(d.spammer, '⚠️ YES', 'false')}`,
      `🚫 Do Not Call: ${boolLine(d.do_not_call, '⚠️ YES', 'false')}`,
      ``,
      `👤 Name: ${esc(d.name ?? 'N/A')}`,
      `📶 Carrier: ${esc(d.carrier ?? 'N/A')}`,
      `🔌 Line Type: ${esc(d.line_type ?? 'N/A')}`,
      ``,
      `🌍 Country: ${esc(d.country ?? 'N/A')} ${flagEmoji(d.country)}`,
      `🏙 City: ${esc(d.city ?? 'N/A')}`,
      `📍 Region: ${esc(d.region ?? 'N/A')}`,
      `📮 Zip Code: ${esc(d.zip_code ?? 'N/A')}`,
      `⏰ Timezone: ${esc(d.timezone ?? 'N/A')}`,
      `📲 Dialing Code: ${d.dialing_code ?? 'N/A'}`,
      ``,
      `📊 Active Status: ${esc(d.active_status ?? 'N/A')}`,
    ];

    const text = lines.join('\n');
    const { InlineKeyboard: IK } = await import('grammy');
    const kb = new IK().text('🔙 Back to My Numbers', cb('NUM_LIST', 1));

    // Delete the loading message and send the details
    await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => undefined);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => undefined);
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await ctx.reply(`❌ Could not fetch number details: ${esc(msg)}\n\nPlease try again later.`, { parse_mode: 'HTML' });
  }
}

