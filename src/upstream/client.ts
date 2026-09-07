/**
 * Full typed PVADeals API v3.6 client.
 *
 * Contract facts hard-coded here (per official docs — June 22 2026):
 * - Auth: "Authorization: Bearer <key>"  (NOT x-api-key)
 * - STR purchase body: {services:[{serviceId, areaCode?}]}  (array, not flat)
 * - ALL_SERVICES US: POST /v3/api/purchase-ltr {serviceId:"ALL_SERVICES", country:"US"}
 * - ALL_SERVICES UK: POST /v3/api/purchase-ltr {serviceId:"ALL_SERVICES", country:"UK"}
 * - LTR purchase body: {duration, serviceId, areaCode?}  (duration = number of days)
 * - flag:  POST /v3/api/flag/{id}
 * - reuse: POST /v3/api/reuse/{id}
 * - renew: POST /v3/api/renew-ltr/{id}
 * - change-duration preview: GET  /v3/api/ltr-change-duration/{id}/preview?duration=N
 * - change-duration commit:  POST /v3/api/ltr-change-duration/{id}  {duration:N}
 * - list requests response: data.data.edges[].node  (cursor pagination)
 * - health + version are NOT wrapped in envelope — handled in health.ts
 */

import { RateLimiter, type EndpointKey } from './rate.js';
import { CircuitBreaker, BreakerOpenError } from './breaker.js';
import { HealthGate, UpstreamDownError } from './health.js';
import type { Env } from '../config/env.js';
import { toCents } from '../domain/money.js';

export { BreakerOpenError, UpstreamDownError };

// ─── Wire shapes ──────────────────────────────────────────────────────────────

interface Envelope<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface UpstreamService {
  _id: string;
  name: string;
  country: string;       // "USA" / "UK" / "GB"
  STRprice: number;      // dollars — from /services/all
  LTR3price: number;
  LTR7price: number;
  LTR14price: number;
  LTR30price: number;
  STRstock: number;
  LTRstock: number;
}

/** Shape from /service/:id — STR price key is "price" not "STRprice" */
export interface UpstreamServiceById {
  _id: string;
  name: string;
  country: string;
  price: number;         // STR price (dollars)
  LTR3price: number;
  LTR7price: number;
  LTR14price: number;
  LTR30price: number;
  STRstock: number;
  LTRstock: number;
}

export interface UpstreamCode {
  _id?: string;
  requestId?: string;
  parentId?: string;
  message?: string;
  pin?: string;
  fromNumber?: string;
  toNumber?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpstreamRequest {
  _id: string;
  serviceName: string;
  serviceId: string;
  number: string;
  status: string;         // RESERVED | COMPLETED | FLAGGED | TIMEOUT
  country: string;        // "US" / "UK"
  amount: number;         // dollars charged
  numberType: string;     // STR | LTR
  allowFlag: boolean;
  allowReuse: boolean;
  reuseCounter: number;
  endTime: string;        // ISO
  autoRenewEnable?: boolean;
  duration?: number;      // only on LTR requests
  createdAt?: string;
  codes?: UpstreamCode[];
  message?: string;
}

export interface UpstreamBalance {
  credits: number; // dollars
}

export interface ChangeDurationPreview {
  currentDuration: number;
  targetDuration: number;
  fixedUpgradeFee: number;
  currentDurationPrice: number;
  targetDurationPrice: number;
  durationPriceDifference: number;
  totalUpgradeCost: number;
  newExpiry: string;
  walletBalance: number;
  message: string;
}

export interface PurchaseResult {
  requestId: string;
  number: string;
  serviceName: string;
  serviceId: string;
  status: string;
  endTime: string;
  amount: number; // dollars
  numberType: string;
  country: string;
}

// ─── Domain-mapped output types ───────────────────────────────────────────────

export interface ServiceWithCents extends Omit<UpstreamService, 'STRprice' | 'LTR3price' | 'LTR7price' | 'LTR14price' | 'LTR30price'> {
  strCostCents: number;
  ltr3CostCents: number;
  ltr7CostCents: number;
  ltr14CostCents: number;
  ltr30CostCents: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class PvaDealsClient {
  private readonly limiter = new RateLimiter();
  readonly breaker = new CircuitBreaker();
  readonly health: HealthGate;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.health = new HealthGate(baseUrl, apiKey);
  }

  static fromEnv(env: Env): PvaDealsClient {
    return new PvaDealsClient(env.PVADEALS_BASE_URL, env.PVADEALS_API_KEY);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async request<T>(
    path: string,
    endpoint: EndpointKey,
    init: RequestInit = {},
  ): Promise<T> {
    this.health.assertHealthy();
    await this.limiter.acquire(endpoint);

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        // ✅ Correct auth: Bearer token (NOT x-api-key)
        'Authorization': `Bearer ${this.apiKey}`,
        ...init.headers,
      },
    });

    const body = await res.json() as Envelope<T>;

    if (!res.ok || !body.success) {
      const msg = (body as { message?: string }).message ?? `HTTP ${res.status}`;
      throw new UpstreamApiError(msg, res.status, body);
    }

    return body.data;
  }

  private async purchaseRequest<T>(
    path: string,
    endpoint: EndpointKey,
    payload: unknown,
  ): Promise<T> {
    this.breaker.assertClosed();
    let ok = false;
    try {
      const result = await this.request<T>(path, endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      ok = true;
      return result;
    } finally {
      this.breaker.recordResult(ok);
    }
  }

  // ── Balance ───────────────────────────────────────────────────────────────

  async getBalance(): Promise<{ dollars: number; cents: number }> {
    const data = await this.request<UpstreamBalance>('/v3/api/balance', 'balance');
    return { dollars: data.credits, cents: toCents(data.credits) };
  }

  // ── Services ──────────────────────────────────────────────────────────────

  async listServices(): Promise<ServiceWithCents[]> {
    const data = await this.request<{ services: UpstreamService[] }>(
      '/v3/api/services/all',
      'services_all',
    );
    return data.services.map(mapServiceToCents);
  }

  async getService(serviceId: string): Promise<ServiceWithCents> {
    const data = await this.request<UpstreamServiceById>(
      `/v3/api/service/${encodeURIComponent(serviceId)}`,
      'service_by_id',
    );
    return {
      _id: data._id,
      name: data.name,
      country: data.country,
      strCostCents: toCents(data.price),
      ltr3CostCents: toCents(data.LTR3price),
      ltr7CostCents: toCents(data.LTR7price),
      ltr14CostCents: toCents(data.LTR14price),
      ltr30CostCents: toCents(data.LTR30price),
      STRstock: data.STRstock,
      LTRstock: data.LTRstock,
    };
  }

  // ── Requests (active numbers) ─────────────────────────────────────────────

  async listRequests(opts: { first?: number; after?: string } = {}): Promise<{
    requests: UpstreamRequest[];
    nextCursor: string | null;
  }> {
    const params = new URLSearchParams();
    if (opts.first) params.set('first', String(opts.first));
    if (opts.after) params.set('after', opts.after);
    params.set('orderBy', 'desc');
    const qs = `?${params.toString()}`;

    // Response: data.data.edges[].node  (cursor-paginated)
    const data = await this.request<{
      data: { edges: Array<{ cursor: string; node: UpstreamRequest }> };
    }>(`/v3/api/requests${qs}`, 'requests');

    const edges = data?.data?.edges ?? [];
    return {
      requests: edges.map((e) => e.node),
      nextCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    };
  }

  async getRequest(requestId: string): Promise<UpstreamRequest> {
    return this.request<UpstreamRequest>(
      `/v3/api/request/${encodeURIComponent(requestId)}`,
      'request_by_id',
    );
  }

  // ── Purchase STR ──────────────────────────────────────────────────────────

  /** STR purchase — body must be {services:[{serviceId, areaCode?}]} (array). */
  async purchaseStr(serviceId: string, areaCode?: string): Promise<PurchaseResult> {
    const svc: Record<string, string> = { serviceId };
    if (areaCode) svc.areaCode = areaCode;
    // ✅ Correct body shape: services array
    const raw = await this.purchaseRequest<{ requests: Array<Record<string, unknown>> }>(
      '/v3/api/purchase',
      'purchase',
      { services: [svc] },
    );
    const r = raw.requests[0]!;
    return mapRequest(r);
  }

  // ── Purchase LTR ──────────────────────────────────────────────────────────

  async purchaseLtr(
    serviceId: string,
    duration: 3 | 7 | 14 | 30,
    areaCode?: string,
  ): Promise<PurchaseResult> {
    const body: Record<string, string | number> = { serviceId, duration };
    if (areaCode) body.areaCode = areaCode;
    const raw = await this.purchaseRequest<Record<string, unknown>>(
      '/v3/api/purchase-ltr',
      'purchase_ltr',
      body,
    );
    return mapRequest(raw);
  }

  // ── Purchase ALL_SERVICES ─────────────────────────────────────────────────

  /** US all-services 28-day number via purchase-ltr */
  async purchaseAllServicesUs(): Promise<PurchaseResult> {
    const raw = await this.purchaseRequest<Record<string, unknown>>(
      '/v3/api/purchase-ltr',
      'purchase_ltr',
      { serviceId: 'ALL_SERVICES', country: 'US' },
    );
    return mapRequest(raw);
  }

  /** UK all-services 30-day number via purchase-ltr */
  async purchaseAllServicesUk(): Promise<PurchaseResult> {
    const raw = await this.purchaseRequest<Record<string, unknown>>(
      '/v3/api/purchase-ltr',
      'purchase_ltr',
      { serviceId: 'ALL_SERVICES', country: 'UK' },
    );
    return mapRequest(raw);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /** Flag a number. Check allowFlag first — 422 if false. */
  async flagRequest(requestId: string): Promise<boolean> {
    // ✅ Correct path: /v3/api/flag/{id}
    const data = await this.request<boolean>(
      `/v3/api/flag/${encodeURIComponent(requestId)}`,
      'flag_reuse_renew',
      { method: 'POST' },
    );
    return data;
  }

  /** Reuse a number for another OTP. Returns request with amount:0. */
  async reuseRequest(requestId: string): Promise<UpstreamRequest> {
    // ✅ Correct path: /v3/api/reuse/{id}
    return this.request<UpstreamRequest>(
      `/v3/api/reuse/${encodeURIComponent(requestId)}`,
      'flag_reuse_renew',
      { method: 'POST' },
    );
  }

  /** Toggle auto-renew on an LTR number. */
  async renewLtr(requestId: string): Promise<UpstreamRequest> {
    // ✅ Correct path: /v3/api/renew-ltr/{id}
    return this.request<UpstreamRequest>(
      `/v3/api/renew-ltr/${encodeURIComponent(requestId)}`,
      'flag_reuse_renew',
      { method: 'POST' },
    );
  }

  /** Preview a duration upgrade. No charge. */
  async previewChangeDuration(
    requestId: string,
    targetDuration: 7 | 14 | 30,
  ): Promise<ChangeDurationPreview> {
    // ✅ Correct: GET with ?duration= query param
    return this.request<ChangeDurationPreview>(
      `/v3/api/ltr-change-duration/${encodeURIComponent(requestId)}/preview?duration=${targetDuration}`,
      'default',
    );
  }

  /** Commit a duration upgrade after the customer confirms. */
  async commitChangeDuration(
    requestId: string,
    targetDuration: 7 | 14 | 30,
  ): Promise<UpstreamRequest> {
    // ✅ Correct: POST /v3/api/ltr-change-duration/{id} {duration:N}
    return this.request<UpstreamRequest>(
      `/v3/api/ltr-change-duration/${encodeURIComponent(requestId)}`,
      'default',
      {
        method: 'POST',
        body: JSON.stringify({ duration: targetDuration }),
      },
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapServiceToCents(s: UpstreamService): ServiceWithCents {
  return {
    _id: s._id,
    name: s.name,
    country: s.country,
    strCostCents: toCents(s.STRprice),
    ltr3CostCents: toCents(s.LTR3price),
    ltr7CostCents: toCents(s.LTR7price),
    ltr14CostCents: toCents(s.LTR14price),
    ltr30CostCents: toCents(s.LTR30price),
    STRstock: s.STRstock,
    LTRstock: s.LTRstock,
  };
}

function mapRequest(r: Record<string, unknown>): PurchaseResult {
  return {
    requestId: String(r._id ?? ''),
    number: String(r.number ?? ''),
    serviceName: String(r.serviceName ?? ''),
    serviceId: String(r.serviceId ?? ''),
    status: String(r.status ?? 'RESERVED'),
    endTime: String(r.endTime ?? new Date(Date.now() + 20 * 60_000).toISOString()),
    amount: Number(r.amount ?? 0),
    numberType: String(r.numberType ?? 'STR'),
    country: String(r.country ?? 'US'),
  };
}

export class UpstreamApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'UpstreamApiError';
  }
}
