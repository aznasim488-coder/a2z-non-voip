/**
 * Health gate — polls /v3/api/health every 30 s.
 *
 * IMPORTANT: /v3/api/health returns an UNWRAPPED response (no {success,data}
 * envelope). The upstream server caches the result for 5 s so polling faster
 * than 30 s wastes quota.
 */

const POLL_MS = 30_000;
const TIMEOUT_MS = 8_000;

export class HealthGate {
  private _healthy = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get healthy(): boolean { return this._healthy; }

  assertHealthy(): void {
    if (!this._healthy) throw new UpstreamDownError();
  }

  private async poll(): Promise<void> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/v3/api/health`, {
        // Health is public (no auth required) but we include auth anyway
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: ac.signal,
      });
      if (!res.ok) { this._healthy = false; return; }
      // Unwrapped — { status: "operational" | "maintenance" | "unavailable" }
      const body = await res.json() as { status?: string };
      this._healthy = body.status === 'operational';
    } catch {
      this._healthy = false;
    } finally {
      clearTimeout(t);
    }
  }
}

export class UpstreamDownError extends Error {
  constructor() {
    super('The number service is temporarily unavailable. Please try again shortly.');
    this.name = 'UpstreamDownError';
  }
}
