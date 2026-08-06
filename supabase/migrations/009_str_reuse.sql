-- Migration: Add reuse_count to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reuse_count INT NOT NULL DEFAULT 0;
