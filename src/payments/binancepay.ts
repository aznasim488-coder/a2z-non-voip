/**
 * Binance Personal Account — Pay Transaction Query
 *
 * Uses the standard Binance REST API (api.binance.com), NOT the merchant API.
 * Requires a personal Binance API key with "Wallet" READ permission only.
 * No merchant account needed.
 *
 * Docs: https://developers.binance.com/docs/wallet/balance/fetch-pay-trade-history
 * Endpoint: GET /sapi/v1/pay/transactions
 * Auth: HMAC-SHA256 on query string (standard Binance API auth)
 *
 * Permissions required on API key:
 *   ✅ Enable Reading (Wallet)
 *   ❌ Trading NOT required
 *   ❌ Withdrawals NOT required
 *   ✅ Restrict to trusted IPs recommended
 */

import { createHmac } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BinancePersonalConfig {
  apiKey: string;       // Personal Binance API key (Read permission)
  secretKey: string;    // Personal Binance API secret
  binanceId: string;    // Your public Binance ID shown to users e.g. "443874127"
}

/** One outgoing or incoming Binance Pay transfer on a personal account. */
export interface BinancePayTx {
  orderType: string;          // 'C2C' for person-to-person
  transactionId: string;
  transactionTime: number;    // Unix ms
  amount: string;             // '10.00000000'
  currency: string;           // 'USDT'
  payerInfo: {
    name: string;             // Sender's display name — what user sees in Binance app
    type: string;
    binanceId: string;
    accountId: string;
  };
  receiverInfo: {
    name: string;
    type: string;
    binanceId: string;
    accountId: string;
  };
}

export interface VerifyResult {
  matched: boolean;
  transaction?: BinancePayTx;
  reason?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL         = 'https://api.binance.com';
const AMOUNT_TOLERANCE = 0.02;        // $0.02 tolerance for rounding
const MATCH_WINDOW_MS  = 45 * 60_000; // look back 45 minutes

// ─── Signature (standard Binance HMAC-SHA256) ─────────────────────────────────

function sign(secretKey: string, queryString: string): string {
  return createHmac('sha256', secretKey).update(queryString).digest('hex');
}

// ─── Fetch recent INCOMING Pay transactions ────────────────────────────────────

/**
 * Returns recent USDT Pay transactions received on this account.
 * Only transactions where THIS account is the RECEIVER are returned.
 */
export async function listRecentTransactions(
  config: BinancePersonalConfig,
): Promise<BinancePayTx[]> {
  const endTime   = Date.now();
  const startTime = endTime - MATCH_WINDOW_MS;

  const params = new URLSearchParams({
    startTimestamp: String(startTime),
    endTimestamp:   String(endTime),
    timestamp:      String(Date.now()),
    limit:          '100',
  });

  const signature = sign(config.secretKey, params.toString());
  params.set('signature', signature);

  const url = `${BASE_URL}/sapi/v1/pay/transactions?${params.toString()}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-MBX-APIKEY': config.apiKey,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Binance API error ${res.status}: ${text}`);
  }

  const json = await res.json() as {
    code: string;
    message: string;
    data: BinancePayTx[];
  };

  if (json.code !== '000000') {
    throw new Error(`Binance API returned code ${json.code}: ${json.message}`);
  }

  // Only keep incoming USDT payments (where WE are the receiver)
  return (json.data ?? []).filter(
    (tx) =>
      tx.currency === 'USDT' &&
      tx.orderType === 'C2C' &&
      tx.receiverInfo?.binanceId === config.binanceId,
  );
}

// ─── Verify a specific payment ────────────────────────────────────────────────

/**
 * Search recent transactions for one matching:
 *   • sender display name (case-insensitive, partial match allowed)
 *   • USDT amount (±$0.02 tolerance)
 *   • received in the last 45 minutes
 */
export async function verifyPayment(
  config: BinancePersonalConfig,
  senderName: string,
  expectedAmountUsdt: number,
): Promise<VerifyResult> {
  let transactions: BinancePayTx[];

  try {
    transactions = await listRecentTransactions(config);
  } catch (e) {
    return {
      matched: false,
      reason: `API error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const normalizedInput = senderName.trim().toLowerCase();

  for (const tx of transactions) {
    const txName    = (tx.payerInfo?.name ?? '').trim().toLowerCase();
    const txAmount  = parseFloat(tx.amount);
    const amountOk  = Math.abs(txAmount - expectedAmountUsdt) <= AMOUNT_TOLERANCE;
    const nameOk    = txName === normalizedInput ||
                      txName.includes(normalizedInput) ||
                      normalizedInput.includes(txName);

    if (amountOk && nameOk) {
      return { matched: true, transaction: tx };
    }
  }

  return {
    matched: false,
    reason: `No USDT payment of $${expectedAmountUsdt.toFixed(2)} from "${senderName}" found in the last 45 minutes.`,
  };
}
