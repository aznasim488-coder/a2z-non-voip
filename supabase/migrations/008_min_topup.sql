-- Add configurable minimum top-up amount (admin can change via /setmintopup)
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS min_topup_cents BIGINT NOT NULL DEFAULT 300;
