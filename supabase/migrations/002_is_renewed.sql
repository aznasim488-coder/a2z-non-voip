-- Migration: Add is_renewed flag + expired-order auto-refund support
-- Run this in Supabase SQL Editor

-- 1. Mark whether an LTR has ever been renewed (used to skip auto-refund on expiry)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_renewed boolean NOT NULL DEFAULT false;

-- 2. Index for the reconcile sweep query (expired RESERVED orders)
CREATE INDEX IF NOT EXISTS idx_orders_expired_reserved
  ON orders (status, end_time, type, is_renewed)
  WHERE status = 'RESERVED';
