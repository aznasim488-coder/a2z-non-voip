/**
 * HTML formatting helpers for grammY messages.
 *
 * Use HTML parse mode (parse_mode: 'HTML'), NOT MarkdownV2.
 * Service names contain '.', '-', '(' which would need constant escaping in
 * MarkdownV2 but are safe in HTML.
 *
 * <code> tags render as tap-to-copy on mobile — use them for phone numbers,
 * OTP codes, and request IDs.
 */

import { formatCents } from '../../domain/money.js';

/** Escape user-supplied text for HTML to prevent injection. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Render a balance line. */
export function balanceLine(cents: number): string {
  return `💳 Balance: <b>${formatCents(cents)}</b>`;
}

/** Render an OTP code in a tap-to-copy block. */
export function otpBlock(code: string): string {
  return `🔑 OTP: <code>${esc(code)}</code>`;
}

/** Render phone number as tap-to-copy. */
export function phoneBlock(number: string): string {
  return `📱 Number: <code>${esc(number)}</code>`;
}

/** Render a price cell: service name + plan prices. */
export function servicePriceLine(
  name: string,
  prices: { plan: string; cents: number }[],
): string {
  const priceList = prices.map((p) => `  ${p.plan}: <b>${formatCents(p.cents)}</b>`).join('\n');
  return `<b>${esc(name)}</b>\n${priceList}`;
}

/** Simple horizontal rule for section breaks. */
export const HR = '─'.repeat(20);

/** Format an expiry timestamp nicely. */
export function expiryLine(endTime: string): string {
  const d = new Date(endTime);
  return `⏱ Expires: <b>${d.toUTCString()}</b>`;
}

/** Error message for the user — never leak raw upstream errors. */
export function userError(msg: string): string {
  return `❌ ${esc(msg)}`;
}

/** Success acknowledgement. */
export function userSuccess(msg: string): string {
  return `✅ ${esc(msg)}`;
}

/** Info line. */
export function info(msg: string): string {
  return `ℹ️ ${esc(msg)}`;
}

/** Warning line. */
export function warn(msg: string): string {
  return `⚠️ ${esc(msg)}`;
}
