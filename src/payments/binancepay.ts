/**
 * Binance Personal Account — Pay Transaction Query
 * GET /sapi/v1/pay/transactions
 * Requires: personal API key with Enable Reading
 * Works from: Singapore / SE Asia (Railway Singapore region)
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
  amount: string;
  currency: string;
  payerInfo: {
    name: string;
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

const BASE_URL         = 'https://api.binance.com';
const AMOUNT_TOLERANCE = 0.05;
const MATCH_WINDOW_MS  = 45 * 60_000;

function sign(secretKey: string, queryString: string): string {
  return createHmac('sha256', secretKey).update(queryString).digest('hex');
}

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
    code: string | number;
    message?: string;
    msg?: string;
    data: BinancePayTx[];
  };

  console.log('[binance-pay] raw response:', JSON.stringify(json, null, 2));

  const code = String(json.code);
  if (code !== '000000') {
    throw new Error(`Binance API: ${json.msg ?? json.message ?? code}`);
  }

  return json.data ?? [];
}

export async function verifyPayment(
  config: BinancePersonalConfig,
  senderName: string,
  expectedAmountUsdt: number,
): Promise<VerifyResult> {
  let transactions: BinancePayTx[];

  try {
    transactions = await listRecentTransactions(config);
  } catch (e) {
    return { matched: false, reason: e instanceof Error ? e.message : String(e) };
  }

  const input = senderName.trim().toLowerCase();

  console.log(`[binance-pay] ${transactions.length} txs — looking for name="${senderName}" amount=$${expectedAmountUsdt}`);
  for (const tx of transactions) {
    console.log(`  tx ${tx.transactionId}: ${tx.amount} ${tx.currency} from "${tx.payerInfo?.name}"`);
  }

  for (const tx of transactions) {
    if (tx.currency !== 'USDT') continue;
    const txName   = (tx.payerInfo?.name ?? '').trim().toLowerCase();
    const txAmount = parseFloat(tx.amount);
    const amountOk = Math.abs(txAmount - expectedAmountUsdt) <= AMOUNT_TOLERANCE;
    const nameOk   = txName === input || txName.includes(input) || input.includes(txName);

    if (amountOk && nameOk) {
      console.log(`[binance-pay] ✅ matched ${tx.transactionId}`);
      return { matched: true, transaction: tx };
    }
  }

  return {
    matched: false,
    reason: `No USDT payment of $${expectedAmountUsdt.toFixed(2)} from "${senderName}" in last 45 min.`,
  };
}
