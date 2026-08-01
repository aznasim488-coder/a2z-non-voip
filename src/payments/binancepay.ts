/**
 * Binance Personal Account — Pay Transaction Query
 * GET /sapi/v1/pay/transactions
 * Requires: personal API key with Enable Reading
 */

import { createHmac } from 'node:crypto';

export interface BinancePersonalConfig {
  apiKey: string;
  secretKey: string;
  binanceId: string;
}

export interface BinancePayTx {
  orderType: string;
  transactionId: string;
  transactionTime: number;
  amount: string;             // '3.00000000'
  currency: string;           // 'USDT'
  payerInfo: {
    name: string;             // Display name of sender
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

const BASE_URL        = 'https://api.binance.com';
const AMOUNT_TOLERANCE = 0.05;         // $0.05 — covers any fee rounding
const MATCH_WINDOW_MS  = 45 * 60_000; // look back 45 minutes

function sign(secretKey: string, queryString: string): string {
  return createHmac('sha256', secretKey).update(queryString).digest('hex');
}

/** Fetch ALL recent Pay transactions for this account (incoming + outgoing). */
export async function listRecentTransactions(
  config: BinancePersonalConfig,
): Promise<BinancePayTx[]> {
  const now       = Date.now();
  const startTime = now - MATCH_WINDOW_MS;

  const params = new URLSearchParams({
    startTimestamp: String(startTime),
    endTimestamp:   String(now),
    timestamp:      String(now),
    limit:          '100',
    recvWindow:     '60000',
  });

  params.append('signature', sign(config.secretKey, params.toString()));

  const res = await fetch(
    `${BASE_URL}/sapi/v1/pay/transactions?${params.toString()}`,
    { headers: { 'X-MBX-APIKEY': config.apiKey } },
  );

  const json = await res.json() as {
    code: string;
    message: string;
    data: BinancePayTx[];
    success?: boolean;
  };

  // Log full raw response for debugging — visible in Railway console
  console.log('[binance-pay] raw API response:', JSON.stringify(json, null, 2));

  if (!res.ok || json.code !== '000000') {
    throw new Error(`Binance API error: ${json.message ?? res.status}`);
  }

  return json.data ?? [];
}

/**
 * Verify payment by matching amount (±$0.05) across ALL transactions.
 * Name match is lenient: checks if entered name appears anywhere in payerInfo.name
 * (handles display name vs username differences).
 *
 * If name doesn't match but amount matches, we log it so admin can see.
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

  console.log(`[binance-pay] checking ${transactions.length} transactions for name="${senderName}" amount=${expectedAmountUsdt}`);

  // Log all recent transactions for debugging
  for (const tx of transactions) {
    console.log(`[binance-pay] tx: id=${tx.transactionId} amount=${tx.amount} ${tx.currency} payer="${tx.payerInfo?.name}" receiver="${tx.receiverInfo?.name}" type=${tx.orderType}`);
  }

  // Try full match first: amount + name
  for (const tx of transactions) {
    if (tx.currency !== 'USDT') continue;

    const txName   = (tx.payerInfo?.name ?? '').trim().toLowerCase();
    const txAmount = parseFloat(tx.amount);
    const amountOk = Math.abs(txAmount - expectedAmountUsdt) <= AMOUNT_TOLERANCE;
    const nameOk   =
      txName.includes(normalizedInput) ||
      normalizedInput.includes(txName) ||
      txName === normalizedInput;

    if (amountOk && nameOk) {
      console.log(`[binance-pay] ✅ matched tx ${tx.transactionId}`);
      return { matched: true, transaction: tx };
    }
  }

  // Soft match: amount only (log it so admin is aware but don't auto-credit)
  for (const tx of transactions) {
    if (tx.currency !== 'USDT') continue;
    const txAmount = parseFloat(tx.amount);
    if (Math.abs(txAmount - expectedAmountUsdt) <= AMOUNT_TOLERANCE) {
      console.log(`[binance-pay] ⚠️ amount-only match tx ${tx.transactionId} payer="${tx.payerInfo?.name}" — name mismatch with "${senderName}"`);
    }
  }

  return {
    matched: false,
    reason: `No USDT payment of $${expectedAmountUsdt.toFixed(2)} from "${senderName}" found. Check Railway console for raw transaction data.`,
  };
}
