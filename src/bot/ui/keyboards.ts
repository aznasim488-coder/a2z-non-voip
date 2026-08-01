import { InlineKeyboard } from 'grammy';
import { cb } from './codec.js';

/** Main menu keyboard for customers. */
export function mainMenuKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Browse Numbers', cb('SVC_LIST', 1)).row()
    .text('🔍 Search Service', cb('SVC_SRCH')).row()
    .text('📱 My Numbers', cb('NUM_LIST', 1)).text('📊 Logs', cb('LOG_MENU')).row()
    .text('💳 Wallet', cb('TOPUP'));
}

/** Admin main menu keyboard. */
export function adminMenuKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💰 Pricing', cb('ADM_PRICE')).text('👥 Users', cb('ADM_USERS')).row()
    .text('📡 Status', cb('ADM_STATUS')).row()
    .text('🏠 Home', cb('HOME'));
}

/** Service list — one button per service, Search button, and Next/Prev nav. */
export function serviceListKb(
  services: Array<{ shortId: number; name: string }>,
  page: number,
  hasMore: boolean,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const svc of services) {
    kb.text(svc.name.slice(0, 30), cb('SVC_VIEW', svc.shortId)).row();
  }
  const nav: Array<[string, string]> = [];
  if (page > 1) nav.push(['◀ Prev', cb('SVC_LIST', page - 1)]);
  if (hasMore) nav.push(['Next ▶', cb('SVC_LIST', page + 1)]);
  for (const [label, data] of nav) kb.text(label, data);
  if (nav.length) kb.row();
  kb.text('🔍 Search', cb('SVC_SRCH')).text('🏠 Home', cb('HOME'));
  return kb;
}

/** Buy options for a single service. */
export function buyOptionsKb(shortId: number, hasLtr: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('⚡ 20-min STR', cb('BUY_STR', shortId)).row();
  if (hasLtr) {
    kb.text('3 days', cb('BUY_LTR3', shortId))
      .text('7 days', cb('BUY_LTR7', shortId)).row()
      .text('14 days', cb('BUY_LTR14', shortId))
      .text('30 days', cb('BUY_LTR30', shortId)).row();
  }
  kb.text('🔙 Back', cb('SVC_LIST', 1)).text('🏠 Home', cb('HOME'));
  return kb;
}

/** Buy ALL_SERVICES options. */
export function allServicesKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🇺🇸 US Number', cb('BUY_ALL_US')).row()
    .text('🇬🇧 UK Number (30-day)', cb('BUY_ALL_UK')).row()
    .text('🔙 Back', cb('SVC_LIST', 1)).text('🏠 Home', cb('HOME'));
}

/** Confirm purchase keyboard. */
export function confirmKb(plan: string, shortId: string | number): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Confirm Purchase', cb('BUY_CFM', plan, shortId)).row()
    .text('❌ Cancel', cb('HOME'));
}

/** Active number actions keyboard — tailored for STR vs LTR. */
export function numberActionsKb(
  requestId: string,
  opts: {
    canFlag: boolean;
    canReuse: boolean;
    canRenew: boolean;
    canChangeDur: boolean;
    autoRenew?: boolean;
    currentDuration?: number;
  },
): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Get OTP (STR + LTR after receiving SMS)
  if (opts.canReuse) kb.text('🔄 Get OTP', cb('ACT_REUSE', requestId)).row();

  // Flag (only before OTP received)
  if (opts.canFlag) kb.text('🚩 Flag Number', cb('ACT_FLAG', requestId)).row();

  // LTR-specific options
  if (opts.canRenew || opts.canChangeDur) {
    // Auto Renew toggle
    const arLabel = opts.autoRenew ? '🟢 Auto Renew: ON' : '🔴 Auto Renew: OFF';
    kb.text(arLabel, cb('ACT_AUTO', requestId)).row();

    // New number (renew)
    kb.text('🔁 New Number', cb('ACT_RENEW', requestId)).row();

    // Upgrade duration (only LTR)
    if (opts.canChangeDur) {
      const cur = opts.currentDuration ?? 3;
      const upgrades: Array<[string, 7 | 14 | 30]> = [];
      if (cur < 7)  upgrades.push(['⇅ 7 days',  7]);
      if (cur < 14) upgrades.push(['⇅ 14 days', 14]);
      if (cur < 30) upgrades.push(['⇅ 30 days', 30]);
      for (const [label, dur] of upgrades) {
        kb.text(label, cb('ACT_DUR', requestId, dur));
      }
      if (upgrades.length) kb.row();
    }
  }

  kb.text('🔙 My Numbers', cb('NUM_LIST', 1)).text('🏠 Home', cb('HOME'));
  return kb;
}

/** Pagination keyboard for "My Numbers". */
export function myNumbersNavKb(page: number, hasMore: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (page > 1) kb.text('◀ Prev', cb('NUM_LIST', page - 1));
  if (hasMore) kb.text('Next ▶', cb('NUM_LIST', page + 1));
  if (page > 1 || hasMore) kb.row();
  kb.text('🏠 Home', cb('HOME'));
  return kb;
}

/** Admin pricing submenu. */
export function adminPricingKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📊 Plan Defaults', cb('ADM_PLAN_DEFS')).row()
    .text('🏷 Service Overrides', cb('ADM_SVC_PRICES')).row()
    .text('📤 Export CSV', cb('ADM_CSV_EXP')).row()
    .text('🔙 Admin Menu', cb('ADM_MAIN'));
}

/** Admin credit form keyboard. */
export function adminCreditKb(userId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔙 Users', cb('ADM_USERS'));
}

/** Country picker — shown when a service has both US and UK variants. */
export function countryPickKb(usShortId: number, ukShortId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('🇺🇸 US Number', cb('SVC_DET', usShortId)).row()
    .text('🇬🇧 UK Number', cb('SVC_DET', ukShortId)).row()
    .text('🔙 Browse', cb('SVC_LIST', 1)).text('🏠 Home', cb('HOME'));
}
