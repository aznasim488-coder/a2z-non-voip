/**
 * bKash Tokenized Checkout API
 *
 * Docs: https://developer.bka.sh/docs/
 * Used for: verifying Send Money transactions by TrxID
 *
 * Flow:
 *   1. Generate token (POST /tokenized/checkout/token/request)
 *   2. Search transaction (POST /tokenized/checkout/general/searchTransaction)
 *   3. Verify: receiver number matches our bKash number + amount matches + status=Completed
 *
 * Merchant credentials required:
 *   BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_USERNAME, BKASH_PASSWORD
 */

export interface BkashConfig {
  baseUrl: string;       // https://tokenized.pay.bka.sh/v1.2.0-beta
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
  numberSmall: string;   // bKash number for small amounts (< limit)
  numberLarge: string;   // bKash number for large amounts (>= limit)
  limitTk: number;       // threshold e.g. 500
  rateTk: number;        // TK per $1 e.g. 125
}

export interface BkashTransaction {
  trxID: string;
  amount: string;
  currency: string;
  transactionStatus: string;   // 'Completed'
  receiverMSISDN?: string;
  debitMSISDN?: string;
  completedTime?: string;
  customerMsisdn?: string;
}

export interface BkashVerifyResult {
  verified: boolean;
  transaction?: BkashTransaction;
  amountTk?: number;
  amountUsd?: number;
  reason?: string;
}

// ─── Token cache (valid 1 hour) ────────────────────────────────────────────────
let _cachedToken: string | null = null;
let _tokenExpiry: number = 0;

async function getToken(config: BkashConfig): Promise<string> {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const res = await fetch(`${config.baseUrl}/tokenized/checkout/token/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      username: config.username,
      password: config.password,
    },
    body: JSON.stringify({
      app_key: config.appKey,
      app_secret: config.appSecret,
    }),
  });

  const json = await res.json() as {
    id_token?: string;
    token_type?: string;
    statusCode?: string;
    statusMessage?: string;
  };

  console.log('[bkash] token response:', JSON.stringify(json));

  if (!json.id_token) {
    throw new Error(`bKash token error: ${json.statusMessage ?? 'unknown'}`);
  }

  _cachedToken = json.id_token;
  _tokenExpiry = Date.now() + 55 * 60_000; // 55 min (tokens expire at 60 min)
  return _cachedToken;
}

// ─── Search transaction by TrxID ──────────────────────────────────────────────

export async function searchTransaction(
  config: BkashConfig,
  trxID: string,
): Promise<BkashTransaction | null> {
  const token = await getToken(config);

  const res = await fetch(
    `${config.baseUrl}/tokenized/checkout/general/searchTransaction`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-App-Key': config.appKey,
      },
      body: JSON.stringify({ trxID }),
    },
  );

  const json = await res.json() as BkashTransaction & {
    statusCode?: string;
    statusMessage?: string;
  };

  console.log('[bkash] searchTransaction response:', JSON.stringify(json));

  if (json.statusCode && json.statusCode !== '0000') {
    console.log(`[bkash] tx not found: ${json.statusMessage}`);
    return null;
  }

  return json;
}

// ─── Verify a bKash payment ───────────────────────────────────────────────────

/**
 * Verify that:
 *   1. TrxID exists in bKash
 *   2. Transaction status = "Completed"
 *   3. Receiver MSISDN = one of our configured bKash numbers
 *   4. Amount matches what user submitted (±2 TK tolerance)
 */
export async function verifyBkashPayment(
  config: BkashConfig,
  trxID: string,
  submittedAmountTk: number,
): Promise<BkashVerifyResult> {
  let tx: BkashTransaction | null;

  try {
    tx = await searchTransaction(config, trxID.trim());
  } catch (e) {
    return {
      verified: false,
      reason: `API error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!tx) {
    return { verified: false, reason: 'Transaction not found. Check your TrxID.' };
  }

  if (tx.transactionStatus?.toLowerCase() !== 'completed') {
    return {
      verified: false,
      reason: `Transaction status is "${tx.transactionStatus}" — not completed yet.`,
    };
  }

  // Check receiver number is one of our bKash numbers
  const receiver = (tx.receiverMSISDN ?? '').replace(/\D/g, '');
  const small     = config.numberSmall.replace(/\D/g, '');
  const large     = config.numberLarge.replace(/\D/g, '');

  if (receiver !== small && receiver !== large) {
    return {
      verified: false,
      reason: `Payment was not sent to our bKash number. Received by: ${receiver}`,
    };
  }

  const actualAmountTk = parseFloat(tx.amount ?? '0');
  if (Math.abs(actualAmountTk - submittedAmountTk) > 2) {
    return {
      verified: false,
      reason:
        `Amount mismatch. You submitted ${submittedAmountTk} TK ` +
        `but we received ${actualAmountTk} TK.`,
    };
  }

  const amountUsd = actualAmountTk / config.rateTk;

  return {
    verified: true,
    transaction: tx,
    amountTk: actualAmountTk,
    amountUsd,
  };
}
