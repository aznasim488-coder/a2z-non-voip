import { createClient } from '@supabase/supabase-js';
import type { Env } from '../config/env.js';

// Only the service_role key is used — never the anon key.
// RLS is enabled as a backstop but all access goes through this admin client.
let _db: ReturnType<typeof createClient> | null = null;

export function getDb(env: Env): ReturnType<typeof createClient> {
  if (!_db) {
    _db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-application': 'pvadeals-bot' } },
    });
  }
  return _db;
}
