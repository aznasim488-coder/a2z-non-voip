/**
 * Callback data codec.
 *
 * Telegram cap: callback_data <= 64 bytes.
 * We encode actions as short strings:  "ACTION:PARAM1:PARAM2..."
 *
 * Action codes (keep short — every char counts):
 *   SVC_LIST   - browse service list page
 *   SVC_VIEW   - view one service (param: shortId)
 *   BUY_STR    - buy STR for service (param: shortId)
 *   BUY_LTR3   - buy LTR 3-day (param: shortId)
 *   BUY_LTR7   - buy LTR 7-day
 *   BUY_LTR14  - buy LTR 14-day
 *   BUY_LTR30  - buy LTR 30-day
 *   BUY_ALL_US - buy ALL_SERVICES US
 *   BUY_ALL_UK - buy ALL_SERVICES UK
 *   BUY_CFM    - confirm purchase (param: plan:shortId)
 *   NUM_LIST   - my numbers page (param: page)
 *   NUM_VIEW   - view one number (param: requestId truncated to 20 chars)
 *   ACT_REUSE  - reuse OTP      (param: requestId)
 *   ACT_FLAG   - flag number    (param: requestId)
 *   ACT_RENEW  - renew LTR      (param: requestId)
 *   ACT_DUR    - change duration (param: requestId:duration)
 *   ACT_IPQS   - IPQS phone number details (param: shortRequestId)
 *   ADM_MAIN   - admin main menu
 *   ADM_PRICE  - admin pricing menu
 *   ADM_USERS  - admin users list
 *   ADM_CREDIT - admin credit page (param: userId)
 *   ADM_STATUS - admin upstream status
 *   TOPUP      - customer top-up info
 *   NOOP       - no-op (for display-only buttons)
 */

export function cb(...parts: (string | number)[]): string {
  const data = parts.join(':');
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error(`callback_data exceeds 64 bytes: "${data}"`);
  }
  return data;
}

export function parseCb(data: string): string[] {
  return data.split(':');
}

/** Truncate a requestId to fit inside callback_data safely. */
export function shortReqId(requestId: string): string {
  return requestId.slice(0, 20);
}
