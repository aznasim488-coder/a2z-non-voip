-- Migration 004: Add 'binancepay' to topup_method enum
-- Run in Supabase SQL Editor

ALTER TYPE topup_method ADD VALUE IF NOT EXISTS 'binancepay';
