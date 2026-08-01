/**
 * Token-bucket rate limiter — enforces PVADeals documented per-key limits.
 *
 * Per-key limits (calls / 60 s):
 *   services_all      10   ← tightest; catalog sync must respect this
 *   purchase_ltr      30
 *   flag_reuse_renew  30
 *   purchase          50
 *   balance           60
 *   requests          60
 *   service_by_id     60
 *   request_by_id    120
 *   default          120
 */

export type EndpointKey =
  | 'services_all'
  | 'purchase_ltr'
  | 'flag_reuse_renew'
  | 'purchase'
  | 'balance'
  | 'requests'
  | 'service_by_id'
  | 'request_by_id'
  | 'default';

interface Bucket {
  tokens: number;
  lastMs: number;
  capacity: number;
  ratePerMs: number;
}

const LIMITS: Record<EndpointKey, number> = {
  services_all: 10,
  purchase_ltr: 30,
  flag_reuse_renew: 30,
  purchase: 50,
  balance: 60,
  requests: 60,
  service_by_id: 60,
  request_by_id: 120,
  default: 120,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  private buckets: Map<EndpointKey, Bucket>;

  constructor() {
    this.buckets = new Map(
      (Object.entries(LIMITS) as [EndpointKey, number][]).map(([key, perMin]) => [
        key,
        {
          tokens: perMin,
          lastMs: Date.now(),
          capacity: perMin,
          ratePerMs: perMin / 60_000,
        },
      ]),
    );
  }

  async acquire(endpoint: EndpointKey): Promise<void> {
    const b = this.buckets.get(endpoint)!;
    while (true) {
      const now = Date.now();
      b.tokens = Math.min(b.capacity, b.tokens + (now - b.lastMs) * b.ratePerMs);
      b.lastMs = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return;
      }
      await sleep(Math.ceil((1 - b.tokens) / b.ratePerMs));
    }
  }
}
