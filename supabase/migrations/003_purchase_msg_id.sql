-- Migration 003: Store purchase message ID for OTP reply threading
-- Run in Supabase SQL Editor

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS purchase_msg_id bigint;
