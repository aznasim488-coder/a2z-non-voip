-- Migration 005: Add 'bkash' and 'nagad' to topup_method enum
-- Run in Supabase SQL Editor

ALTER TYPE topup_method ADD VALUE IF NOT EXISTS 'bkash';
ALTER TYPE topup_method ADD VALUE IF NOT EXISTS 'nagad';
