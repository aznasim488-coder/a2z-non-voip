/**
 * grammY bot instance — composes all handlers.
 *
 * Middleware order:
 *   1. sequentialize(by chat id) — serializes updates per user
 *   2. userMiddleware — upsert, auth check, ctx injection
 *   3. Command / callback handlers
 */

import { Bot } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../config/env.js';
import type { PvaDealsClient } from '../upstream/client.js';
import { userMiddleware, type BotContext } from './middleware.js';
import { isAdmin } from '../config/env.js';
import { parseCb } from './ui/codec.js';
import { mainMenuKb } from './ui/keyboards.js';

// Customer handlers
import { handleStart } from './customer/start.js';
import { handleServiceList, handleServiceView, handleServiceDetail, handleServiceSearch } from './customer/browse.js';
import { handleBuyConfirm, handleBuyExecute, handleSetLoc, handleBuyConfirmState } from './customer/buy.js';
import { handleMyNumbers, handleNumberView } from './customer/my-numbers.js';
import { handleWallet, handleTopupEnter, handleTopupCustomAmount, handleBinanceEnter, handleBinanceNameReply, handleBinanceAmountReply, handleBkashEnter, handleBkashTrxReply, handleBkashAmountReply, handleBkashApprove, handleBkashReject, handleNagadEnter, handleNagadTrxReply, handleNagadAmountReply, handleNagadApprove, handleNagadReject, TOPUP_PROMPT_MARKER, BINANCE_NAME_MARKER, BINANCE_AMOUNT_PREFIX, BKASH_TRXID_MARKER, BKASH_AMOUNT_PREFIX, NAGAD_TRXID_MARKER, NAGAD_AMOUNT_PREFIX } from './customer/wallet.js';
import { handleLogsMenu, handleSmsLogs, handleNumberLogs, handlePaymentLogs } from './customer/logs.js';
import {
  handleReusePrompt,
  handleReuseExecute,
  handleFlag,
  handleRenewPrompt,
  handleRenewExecute,
  handleChangeDurationPreview,
  handleChangeDurationCommit,
  handleToggleAutoRenew,
} from './customer/actions.js';

// Admin handlers
import { handleAdminMenu, handleAdminStatus, handleBroadcast } from './admin/index.js';
import { handleAdminPricing, handleSetPlan, handleSetReuse, handleSetGlobal, handleSetMinTopup, handleExportCsv } from './admin/pricing.js';
import { handleAdminUsers, handleAdminCredit, handleAdminBan } from './admin/users.js';

import type { PlanCode } from '../domain/pricing.js';

export function createBot(
  token: string,
  db: SupabaseClient,
  pva: PvaDealsClient,
  env: Env,
): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // 1. Sequentialize by chat id — prevents concurrent purchase races
  bot.use(
    sequentialize((ctx) => String(ctx.chat?.id ?? ctx.from?.id ?? 'global')),
  );

  // 2. User upsert + ctx injection
  // @ts-ignore — BotContext extends Context, typing works at runtime
  bot.use(userMiddleware(db, pva, env));

  // ── Commands ──────────────────────────────────────────────────────────────

  bot.command('start', (ctx) => handleStart(ctx));
  bot.command('main', (ctx) => handleStart(ctx));
  bot.command('search', async (ctx) => handleServiceSearch(ctx, ctx.match ?? ''));
  bot.command('logs', (ctx) => handleLogsMenu(ctx));
  bot.command('menu', (ctx) => ctx.reply('Main menu:', { reply_markup: mainMenuKb() }));

  // Admin-only commands (gated inside each handler)
  bot.command('admin', (ctx) => handleAdminMenu(ctx));
  bot.command('status', (ctx) => handleAdminStatus(ctx));
  bot.command('users', (ctx) => handleAdminUsers(ctx, 1));
  bot.command('exportcsv', (ctx) => handleExportCsv(ctx));

  bot.command('setplan', async (ctx) => {
    if (!isAdmin(env, ctx.user?.telegram_id)) return;
    const args = (ctx.match ?? '').split(/\s+/);
    if (args.length < 2) { await ctx.reply('Usage: /setplan STR 0.18'); return; }
    await handleSetPlan(ctx, args[0]!, args[1]!);
  });

  bot.command('setreuse', async (ctx) => {
    if (!isAdmin(env, ctx.user?.telegram_id)) return;
    await handleSetReuse(ctx, ctx.match ?? '');
  });

  bot.command('setglobal', async (ctx) => {
    if (!isAdmin(env, ctx.user?.telegram_id)) return;
    await handleSetGlobal(ctx, ctx.match ?? '');
  });

  bot.command('setmintopup', async (ctx) => {
    if (!isAdmin(env, ctx.user?.telegram_id)) return;
    await handleSetMinTopup(ctx, ctx.match ?? '');
  });

  bot.command('credit', async (ctx) => {
    if (!isAdmin(env, ctx.user?.telegram_id)) return;
    const parts = (ctx.match ?? '').split(/\s+/);
    if (parts.length < 3) { await ctx.reply('Usage: /credit &lt;telegram_id&gt; &lt;amount&gt; &lt;note&gt;', { parse_mode: 'HTML' }); return; }
    const tid = parseInt(parts[0]!, 10);
    const amt = parseFloat(parts[1]!);
    const note = parts.slice(2).join(' ');
    if (isNaN(tid) || isNaN(amt)) { await ctx.reply('Invalid arguments.'); return; }
    await handleAdminCredit(ctx, tid, amt, note);
  });

  bot.command('ban', async (ctx) => {
    if (!isAdmin(env, ctx.user?.telegram_id)) return;
    await handleAdminBan(ctx, parseInt(ctx.match ?? '0', 10), true);
  });

  bot.command('unban', async (ctx) => {
    if (!isAdmin(env, ctx.user?.telegram_id)) return;
    await handleAdminBan(ctx, parseInt(ctx.match ?? '0', 10), false);
  });

  bot.command('broadcast', async (ctx) => {
    if (!isAdmin(env, ctx.user?.telegram_id)) return;
    await handleBroadcast(ctx, ctx.match ?? '');
  });

  // ── Callback queries ──────────────────────────────────────────────────────

  bot.on('callback_query:data', async (ctx) => {
    const parts = parseCb(ctx.callbackQuery.data);
    const action = parts[0];

    switch (action) {
      case 'NOOP':
        return;
      case 'HOME':
        return handleStart(ctx);
      case 'SVC_LIST':
        return handleServiceList(ctx, parseInt(parts[1] ?? '1'));
      case 'SVC_VIEW':
        return handleServiceView(ctx, parseInt(parts[1] ?? '0'));
      case 'SVC_DET':
        return handleServiceDetail(ctx, parseInt(parts[1] ?? '0'));
      case 'SVC_SRCH': {
        // ForceReply so user just types the name
        await ctx.reply(
          '🔍 <b>Search Services</b>\n\nType any service name below — you can reply to this message or just send it:',
          {
            parse_mode: 'HTML',
            reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'e.g. airbnb, uber, 1Q...' },
          },
        );
        return;
      }
      case 'BUY_STR':
        return handleBuyConfirm(ctx, 'STR', parseInt(parts[1] ?? '0'));
      case 'BUY_LTR3':
        return handleBuyConfirm(ctx, 'LTR3', parseInt(parts[1] ?? '0'));
      case 'BUY_LTR7':
        return handleBuyConfirm(ctx, 'LTR7', parseInt(parts[1] ?? '0'));
      case 'BUY_LTR14':
        return handleBuyConfirm(ctx, 'LTR14', parseInt(parts[1] ?? '0'));
      case 'BUY_LTR30':
        return handleBuyConfirm(ctx, 'LTR30', parseInt(parts[1] ?? '0'));
      case 'BUY_ALL_US':
        return handleBuyConfirm(ctx, 'ALL_SERVICES_US', 0);
      case 'BUY_ALL_UK':
        return handleBuyConfirm(ctx, 'ALL_SERVICES_UK', 0);
      case 'BUY_CFM': {
        const plan = parts[1] as PlanCode;
        const sid = parseInt(parts[2] ?? '0');
        const areaCode = parts[3];
        return handleBuyExecute(ctx, plan, sid, areaCode);
      }
      case 'BUY_CFM_ST': {
        const plan = parts[1] as PlanCode;
        const sid = parseInt(parts[2] ?? '0');
        const stateIdx = parseInt(parts[3] ?? '0');
        return handleBuyConfirmState(ctx, plan, sid, stateIdx);
      }
      case 'SET_LOC': {
        const plan = parts[1] as PlanCode;
        const sid = parseInt(parts[2] ?? '0');
        const page = parseInt(parts[3] ?? '0');
        return handleSetLoc(ctx, plan, sid, page);
      }
      case 'NUM_LIST':
        return handleMyNumbers(ctx, parseInt(parts[1] ?? '1'));
      case 'NUM_VIEW':
        return handleNumberView(ctx, parts[1] ?? '');
      case 'ACT_REUSE':
        return handleReusePrompt(ctx, parts[1] ?? '');
      case 'ACT_REUSE_CFM':
        return handleReuseExecute(ctx, parts[1] ?? '');
      case 'ACT_FLAG':
        return handleFlag(ctx, parts[1] ?? '');
      case 'ACT_RENEW':
        return handleRenewPrompt(ctx, parts[1] ?? '');
      case 'ACT_RENEW_CFM':
        return handleRenewExecute(ctx, parts[1] ?? '');
      case 'ACT_AUTO':
        return handleToggleAutoRenew(ctx, parts[1] ?? '');
      case 'ACT_DUR': {
        const dur = parseInt(parts[2] ?? '7') as 7 | 14 | 30;
        return handleChangeDurationPreview(ctx, parts[1] ?? '', dur);
      }
      case 'ACT_DUR_CFM': {
        const dur = parseInt(parts[2] ?? '7') as 7 | 14 | 30;
        return handleChangeDurationCommit(ctx, parts[1] ?? '', dur);
      }
      case 'TOPUP':
        return handleWallet(ctx);
      case 'TOPUP_ENTER':
        return handleTopupEnter(ctx);
      case 'BINANCE_ENTER':
        return handleBinanceEnter(ctx);
      case 'BKASH_ENTER':
        return handleBkashEnter(ctx);
      case 'BK_APR': {
        const tid   = parseInt(parts[1] ?? '0');
        const trxId = parts[2] ?? '';
        const cents = parseInt(parts[3] ?? '0');
        return handleBkashApprove(ctx, tid, trxId, cents);
      }
      case 'BK_REJ': {
        const tid   = parseInt(parts[1] ?? '0');
        const trxId = parts[2] ?? '';
        return handleBkashReject(ctx, tid, trxId);
      }
      case 'NAGAD_ENTER':
        return handleNagadEnter(ctx);
      case 'NG_APR': {
        const tid   = parseInt(parts[1] ?? '0');
        const trxId = parts[2] ?? '';
        const cents = parseInt(parts[3] ?? '0');
        return handleNagadApprove(ctx, tid, trxId, cents);
      }
      case 'NG_REJ': {
        const tid   = parseInt(parts[1] ?? '0');
        const trxId = parts[2] ?? '';
        return handleNagadReject(ctx, tid, trxId);
      }
      case 'LOG_MENU':
        return handleLogsMenu(ctx);
      case 'LOG_SMS':
        return handleSmsLogs(ctx, parseInt(parts[1] ?? '1'));
      case 'LOG_NUM':
        return handleNumberLogs(ctx, parseInt(parts[1] ?? '1'));
      case 'LOG_PAY':
        return handlePaymentLogs(ctx, parseInt(parts[1] ?? '1'));
      case 'ADM_MAIN':
        return handleAdminMenu(ctx);
      case 'ADM_PRICE':
        return handleAdminPricing(ctx);
      case 'ADM_USERS':
        return handleAdminUsers(ctx, parseInt(parts[1] ?? '1'));
      case 'ADM_STATUS':
        return handleAdminStatus(ctx);
      default:
        await ctx.reply('Unknown action. Press /start for the main menu.');
    }
  });

  // ── Plain text ────────────────────────────────────────────────────────────
  // 1. If it's a reply to the top-up ForceReply prompt → handle as amount
  // 2. Otherwise treat as service search
  bot.on('message:text', async (ctx) => {
    const text = (ctx.message.text ?? '').trim();
    if (text.startsWith('/')) return;

    const replyTo = ctx.message.reply_to_message?.text ?? '';

    // NOWPayments amount
    if (replyTo.includes(TOPUP_PROMPT_MARKER)) {
      return handleTopupCustomAmount(ctx, text);
    }

    // Binance step 2: display name
    if (replyTo.includes(BINANCE_NAME_MARKER)) {
      return handleBinanceNameReply(ctx, text);
    }

    // Binance step 3: USDT amount
    if (replyTo.includes(BINANCE_AMOUNT_PREFIX)) {
      const markerStart = replyTo.indexOf(BINANCE_AMOUNT_PREFIX) + BINANCE_AMOUNT_PREFIX.length;
      const senderName  = replyTo.slice(markerStart).split('\n')[0]?.trim() ?? '';
      return handleBinanceAmountReply(ctx, text, senderName);
    }

    // bKash step 2: Transaction ID
    if (replyTo.includes(BKASH_TRXID_MARKER)) {
      return handleBkashTrxReply(ctx, text);
    }

    // bKash step 3: TK amount
    if (replyTo.includes(BKASH_AMOUNT_PREFIX)) {
      const markerStart = replyTo.indexOf(BKASH_AMOUNT_PREFIX) + BKASH_AMOUNT_PREFIX.length;
      const trxId       = replyTo.slice(markerStart).split('\n')[0]?.trim() ?? '';
      return handleBkashAmountReply(ctx, text, trxId);
    }

    // Nagad step 2: Transaction ID
    if (replyTo.includes(NAGAD_TRXID_MARKER)) {
      return handleNagadTrxReply(ctx, text);
    }

    // Nagad step 3: TK amount
    if (replyTo.includes(NAGAD_AMOUNT_PREFIX)) {
      const markerStart = replyTo.indexOf(NAGAD_AMOUNT_PREFIX) + NAGAD_AMOUNT_PREFIX.length;
      const trxId       = replyTo.slice(markerStart).split('\n')[0]?.trim() ?? '';
      return handleNagadAmountReply(ctx, text, trxId);
    }

    await handleServiceSearch(ctx, text);
  });

  // ── Error boundary ────────────────────────────────────────────────────────

  bot.catch(async (err) => {
    console.error('[bot error]', { updateId: err.ctx.update.update_id, user: err.ctx.from?.id, err: err.error });
    try {
      await err.ctx.reply('Something went wrong. Please try again or press /start.');
    } catch { /* can't reply */ }
  });

  return bot;
}
