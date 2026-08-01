/**
 * Catalog sync job — fetches all services from PVADeals every 45 s
 * and upserts them into the services_cache table.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PvaDealsClient } from '../upstream/client.js';

const SYNC_INTERVAL_MS = 45_000;

export class CatalogSync {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: SupabaseClient,
    private readonly pva: PvaDealsClient,
  ) {}

  start(): void {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async sync(): Promise<void> {
    try {
      if (!this.pva.health.healthy) return;

      const services = await this.pva.listServices();
      if (services.length === 0) return;

      const rows = services.map((s) => ({
        service_id: s._id,
        name: s.name,
        country: s.country,
        str_cost_cents: s.strCostCents,
        ltr3_cost_cents: s.ltr3CostCents,
        ltr7_cost_cents: s.ltr7CostCents,
        ltr14_cost_cents: s.ltr14CostCents,
        ltr30_cost_cents: s.ltr30CostCents,
        str_stock: s.STRstock,
        ltr_stock: s.LTRstock,
        synced_at: new Date().toISOString(),
      }));

      const { error } = await this.db
        .from('services_cache')
        .upsert(rows, { onConflict: 'service_id' });

      if (error) console.error('[catalog-sync] upsert error:', error.message);
      else console.log(`[catalog-sync] synced ${rows.length} services`);
    } catch (e) {
      console.error('[catalog-sync] error:', e instanceof Error ? e.message : e);
    }
  }
}
