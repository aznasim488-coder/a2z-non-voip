-- Migration 006: bKash + Nagad payment settings stored in DB
-- Admin can update numbers live from inside the bot.
-- Run in Supabase SQL Editor.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS bkash_number    TEXT    DEFAULT '01799424191',
  ADD COLUMN IF NOT EXISTS bkash_rate_tk   INT     DEFAULT 130,
  ADD COLUMN IF NOT EXISTS bkash_min_tk    INT     DEFAULT 390,
  ADD COLUMN IF NOT EXISTS bkash_enabled   BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS nagad_number    TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS nagad_rate_tk   INT     DEFAULT 130,
  ADD COLUMN IF NOT EXISTS nagad_min_tk    INT     DEFAULT 390,
  ADD COLUMN IF NOT EXISTS nagad_enabled   BOOLEAN DEFAULT false;

-- Seed the first bKash number
UPDATE settings SET bkash_number = '01799424191' WHERE bkash_number IS NULL OR bkash_number = '';
