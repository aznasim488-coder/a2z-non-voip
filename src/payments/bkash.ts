/**
 * bKash SMS Parser
 *
 * bKash sends an SMS to the receiver when "Send Money" is received:
 *   "Tk 250.00 received from 01XXXXXXXXX Ref ABC1234XYZ.
 *    Your bKash ac is now Tk XXXX.XX."
 *
 * An SMS-forwarding app on the bKash SIM phone
 * (e.g. SMS Forwarder, SMS Gateway Hub, or any similar app)
 * POSTs the SMS text to our webhook endpoint.
 *
 * We parse TrxID + amount from the SMS text, match to a pending
 * topup submitted by the user, and auto-credit the wallet.
 */

export interface ParsedBkashSms {
  trxId: string;
  amountTk: number;
}

/**
 * Parse a bKash "Send Money received" SMS.
 * Handles multiple known bKash SMS formats.
 * Returns null if the SMS doesn't look like an incoming payment.
 */
export function parseBkashSms(text: string): ParsedBkashSms | null {
  // Must contain "received" or "Cash In" to be an incoming payment
  const lower = text.toLowerCase();
  if (!lower.includes('received') && !lower.includes('cash in')) return null;

  // Extract amount: "Tk 250.00" or "Tk250.00" or "BDT 250"
  const amountMatch = text.match(/[Tt]k[\s]?(\d+(?:\.\d+)?)/);
  if (!amountMatch) return null;
  const amountTk = parseFloat(amountMatch[1]!);
  if (isNaN(amountTk) || amountTk <= 0) return null;

  // Extract TrxID: "Ref ABC1234XYZ" or "TrxID ABC1234XYZ" or "Ref. ABC1234XYZ"
  const trxMatch = text.match(/(?:[Rr]ef\.?|[Tt]rx\s*[Ii][Dd])\s+([A-Z0-9]{6,20})/);
  if (!trxMatch) return null;
  const trxId = trxMatch[1]!.trim();

  return { trxId, amountTk };
}

/** Convert TK → USD cents at given rate */
export function tkToCents(amountTk: number, rateTk: number): number {
  return Math.round((amountTk / rateTk) * 100);
}
