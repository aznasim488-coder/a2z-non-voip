/**
 * IPQualityScore Phone Number Validation API client.
 * Docs: https://www.ipqualityscore.com/documentation/phone-number-validation-api/overview
 */

export interface IpqsPhoneResult {
  success: boolean;
  message: string;
  // Core validity
  valid: boolean;
  active: boolean | null;
  formatted: string;
  local_format: string;
  // Risk signals
  fraud_score: number;
  recent_abuse: boolean | null;
  VOIP: boolean | null;
  prepaid: boolean | null;
  risky: boolean | null;
  leaked: boolean | null;
  spammer: boolean | null;
  do_not_call: boolean | null;
  // Identity
  name: string;
  // Carrier & line
  carrier: string;
  line_type: string;
  // Geo
  country: string;
  region: string;
  city: string;
  zip_code: string;
  timezone: string;
  dialing_code: number | null;
  // Status
  active_status: string;
  // Request tracking
  request_id: string;
}

const IPQS_BASE = 'https://www.ipqualityscore.com/api/json/phone';

/**
 * Lookup a phone number via IPQS.
 * Strips common formatting (spaces, dashes, parens) before sending.
 * Throws on network error or API-level failure (success: false).
 */
export async function lookupPhone(
  apiKey: string,
  phoneNumber: string,
): Promise<IpqsPhoneResult> {
  // Strip non-digits (except leading +)
  const clean = phoneNumber.replace(/(?!^\+)[^\d]/g, '');

  const url = `${IPQS_BASE}/${encodeURIComponent(apiKey)}/${encodeURIComponent(clean)}?strictness=0`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`IPQS HTTP ${res.status}`);
  }

  const json = (await res.json()) as IpqsPhoneResult;

  if (!json.success) {
    throw new Error(json.message ?? 'IPQS returned success=false');
  }

  return json;
}
