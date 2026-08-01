/**
 * bKash — Admin-Approval Flow
 *
 * Personal bKash accounts (Send Money) have no public API.
 * Flow:
 *   1. User submits TrxID + TK amount
 *   2. Bot saves pending topup, DMs admin with [✅ Approve] [❌ Reject] buttons
 *   3. Admin checks their bKash app/SMS and taps a button
 *   4. Bot credits user and notifies them instantly
 *
 * No external API calls needed.
 */

export interface PendingBkashTopup {
  id: string;           // UUID in DB
  userId: string;       // internal user UUID
  telegramId: number;
  firstName: string;
  trxId: string;
  amountTk: number;
  amountCents: number;  // converted at rateTk
  rateTk: number;
}

/** Convert TK → USD cents at given rate */
export function tkToCents(amountTk: number, rateTk: number): number {
  return Math.round((amountTk / rateTk) * 100);
}
