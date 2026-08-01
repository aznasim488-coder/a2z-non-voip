/**
 * Circuit breaker — guards purchase endpoints.
 *
 * PVADeals safety brake: 15 failed purchase calls in 60 s pauses the API key
 * for 5 minutes (outage for all customers). We trip at 8 consecutive failures,
 * lock purchases for 5 min recovery, then let one probe through (half-open).
 */

const THRESHOLD = 8;
const RECOVERY_MS = 5 * 60 * 1_000;

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.openedAt === null) return 'closed';
    return Date.now() - this.openedAt < RECOVERY_MS ? 'open' : 'half-open';
  }

  get remainingMs(): number {
    if (this.openedAt === null) return 0;
    return Math.max(0, RECOVERY_MS - (Date.now() - this.openedAt));
  }

  recordResult(ok: boolean): void {
    if (ok) {
      this.failures = 0;
      this.openedAt = null;
    } else {
      this.failures++;
      if (this.failures >= THRESHOLD) this.openedAt = Date.now();
    }
  }

  assertClosed(): void {
    if (this.state === 'open') {
      const secs = Math.ceil(this.remainingMs / 1000);
      throw new BreakerOpenError(`Purchases paused — too many errors. Retry in ${secs}s.`, this.remainingMs);
    }
  }
}

export class BreakerOpenError extends Error {
  constructor(message: string, public readonly remainingMs: number) {
    super(message);
    this.name = 'BreakerOpenError';
  }
}
