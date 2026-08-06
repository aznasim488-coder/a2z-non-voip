# A2Z Non-VoIP Bot — Complete Project Specification

> **Purpose:** This document contains EVERY detail needed to rebuild this project from scratch. Give this document + the PVADeals API docs to any AI and they can recreate the entire system.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Project Structure](#4-project-structure)
5. [Environment Variables](#5-environment-variables)
6. [Database Schema (Full SQL)](#6-database-schema-full-sql)
7. [Core Domain Logic](#7-core-domain-logic)
8. [PVADeals Upstream API Client](#8-pvadeals-upstream-api-client)
9. [Telegram Bot](#9-telegram-bot)
10. [Payment Integrations](#10-payment-integrations)
11. [Background Jobs](#11-background-jobs)
12. [REST API (Website)](#12-rest-api-website)
13. [Webhook Handlers](#13-webhook-handlers)
14. [Server Entry Point](#14-server-entry-point)
15. [Build & Deployment](#15-build--deployment)
16. [Configuration Files](#16-configuration-files)

---

## 1. Project Overview

**A2Z Non-VoIP Number** is a reseller platform for non-VoIP SMS verification numbers. It wraps the PVADeals v3 API and sells numbers at a markup to end users through two channels:

1. **Telegram Bot** — Primary interface. Users browse services, buy numbers, receive OTPs, manage wallet.
2. **Website** — Static HTML/CSS/JS frontend (separate repo `a2z-website/`) that connects to a REST API on this server.

### Business Model
- Admin buys numbers wholesale from PVADeals upstream API
- Users pay with internal wallet (topped up via Crypto/bKash/Nagad/Binance/Admin credit)
- Sell price = upstream cost × configurable multiplier (default ×2.00 = 100% markup)
- Three-level pricing cascade: service override → plan default → global rule
- All money stored as integer cents (bigint) — never floats

### Key Features
- **STR (Short-Term Rental):** 20-minute numbers for one-time OTP
- **LTR (Long-Term Rental):** 3/7/14/30-day numbers with unlimited OTPs
- **ALL_SERVICES:** Random number that works with any service (US 20-min, UK 30-day)
- **Auto-refund:** STR expired without OTP → auto refund. LTR expired (not renewed) → auto refund
- **Reuse:** Request another OTP on STR ($0.80 charge). Free on active LTR
- **Flag:** Report bad number (before OTP received only)
- **Renew LTR:** Extend rental for same duration (non-refundable)
- **Upgrade Duration:** Change LTR from 3→7→14→30 days (non-refundable)
- **Auto-renew toggle:** For LTR numbers
- **Circuit breaker:** 8 consecutive upstream failures → 5-min purchase pause
- **Health gate:** Polls `/v3/api/health` every 30s, blocks purchases if upstream down
- **Rate limiter:** Token-bucket per endpoint (respects PVADeals per-key limits)
- **Balance watch:** Alerts admin when upstream balance low, auto-pauses purchases at floor
- **Admin panel:** Pricing, user management, ban/unban, credit, broadcast, CSV export

---

## 2. Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Telegram Users  │────▶│  Fastify Server  │────▶│  PVADeals v3    │
│  (grammY bot)    │◀────│  (Railway)       │◀────│  Upstream API   │
└─────────────────┘     │                 │     └─────────────────┘
                        │  Port 3001      │
┌─────────────────┐     │                 │     ┌─────────────────┐
│  Website (HTML)  │────▶│  REST API       │────▶│  Supabase       │
│  (cPanel host)   │◀────│  /api/*         │◀────│  PostgreSQL DB  │
└─────────────────┘     │                 │     └─────────────────┘
                        │  Webhooks:      │
┌─────────────────┐     │  /webhooks/*    │     ┌─────────────────┐
│  NOWPayments     │────▶│                 │     │  Binance API    │
│  bKash SMS fwd   │────▶│                 │────▶│  (verify tx)    │
│  PVADeals events │────▶│                 │     └─────────────────┘
└─────────────────┘     └─────────────────┘
```

### Data Flow
1. **User Registration:** Telegram `/start` → `upsert_telegram_user()` PG function → creates profile + wallet atomically
2. **Purchase:** Check health → Check breaker → Debit wallet (idempotent) → Create order (PENDING_UPSTREAM) → Call upstream → Update order → Notify user. On failure: auto-refund
3. **OTP Delivery:** PVADeals webhook `sms_received` → Store SMS → Mark order COMPLETED → Send OTP to user (reply to purchase message)
4. **Top-up:** Create invoice (NOWPayments) or verify payment (Binance) or pending approval (bKash/Nagad) → Credit wallet

---

## 3. Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | ≥20 |
| Language | TypeScript | 5.7+ |
| Module System | ESM (`"type": "module"`) | ES2022 |
| HTTP Server | Fastify | 5.2+ |
| Bot Framework | grammY | 1.34+ |
| Bot Runner | @grammyjs/runner | 2.0+ |
| Database | Supabase (PostgreSQL) | supabase-js 2.48+ |
| Validation | Zod | 3.24+ |
| CORS | @fastify/cors | 11.3+ |
| Package Manager | npm | — |
| Deployment | Railway (Docker) | node:22-alpine |
| Dev Server | tsx (watch mode) | 4.19+ |

---

## 4. Project Structure

```
pvadeals-bot/
├── src/
│   ├── index.ts                    # Server entry point (Fastify + bot startup)
│   ├── api/
│   │   └── routes.ts               # REST API for website (13 endpoints)
│   ├── bot/
│   │   ├── index.ts                # Bot composition (commands + callbacks + text)
│   │   ├── middleware.ts           # User upsert, auth, rate limit, context injection
│   │   ├── admin/
│   │   │   ├── index.ts            # Admin menu, status, broadcast
│   │   │   ├── pricing.ts          # Plan defaults, global pricing, CSV export
│   │   │   └── users.ts           # User list, credit, ban/unban
│   │   ├── customer/
│   │   │   ├── start.ts            # /start command (welcome + balance)
│   │   │   ├── browse.ts           # Service list, search, detail (paginated, deduplicated US/UK)
│   │   │   ├── buy.ts              # Purchase flow (confirm → execute → refund on failure)
│   │   │   ├── my-numbers.ts       # Active numbers list + detail view
│   │   │   ├── actions.ts          # Reuse, flag, renew, change-duration, auto-renew
│   │   │   ├── wallet.ts           # Wallet screen + all payment flows (NOWPayments, Binance, bKash, Nagad)
│   │   │   └── logs.ts             # SMS logs, number logs (ledger), payment logs
│   │   └── ui/
│   │       ├── codec.ts            # Callback data encoder/decoder (64-byte limit)
│   │       ├── format.ts           # HTML formatting helpers (esc, phone, OTP, etc.)
│   │       └── keyboards.ts        # All InlineKeyboard builders
│   ├── config/
│   │   └── env.ts                  # Zod-validated environment schema + helpers
│   ├── db/
│   │   └── index.ts                # Supabase client singleton (service_role key)
│   ├── domain/
│   │   ├── money.ts                # toCents(), formatCents(), ceilCents()
│   │   ├── orders.ts               # Order CRUD + status types
│   │   ├── pricing.ts              # Three-level price resolution + OTP extraction
│   │   └── wallet.ts               # debitWallet(), creditWallet(), getBalanceCents()
│   ├── jobs/
│   │   ├── balance-watch.ts        # Upstream balance monitor (60s interval)
│   │   ├── catalog-sync.ts         # Service catalog sync (45s interval)
│   │   └── reconcile.ts            # Crash recovery + expired refund + reuse refund
│   ├── payments/
│   │   ├── binancepay.ts           # Binance personal API transaction verification
│   │   ├── bkash.ts                # bKash SMS parser + TK→USD conversion
│   │   ├── cryptopay.ts            # CryptoPay (@CryptoBot) integration (unused currently)
│   │   └── nowpayments.ts          # NOWPayments invoice creation + IPN processing
│   └── upstream/
│       ├── breaker.ts              # Circuit breaker (8 failures → 5min pause)
│       ├── client.ts               # Full PVADeals v3.6 API client
│       ├── health.ts               # Health gate (30s polling)
│       └── rate.ts                 # Token-bucket rate limiter
├── supabase/
│   └── migrations/
│       ├── 001_init.sql            # Full schema + functions + RLS
│       ├── 002_is_renewed.sql      # is_renewed column + index
│       ├── 003_purchase_msg_id.sql # purchase_msg_id column
│       ├── 004_binance_pay.sql     # binancepay enum value
│       ├── 005_bkash.sql           # bkash + nagad enum values
│       ├── 006_payment_settings.sql # Payment settings columns
│       └── 007_web_auth.sql        # Web auth (auth_user_id, link_code, trigger, RLS)
├── package.json
├── tsconfig.json
├── Dockerfile
├── railway.toml
├── .env.example
└── .gitignore
```

---

## 5. Environment Variables

```env
# ─── Core ───────────────────────────────────────────────────────
NODE_ENV="production"                    # development | test | production
PORT="3001"                              # Fastify listen port (1-65535)
PUBLIC_BASE_URL="https://your-app.up.railway.app"  # Must be HTTPS in webhook mode

# ─── Telegram ───────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN="123456789:AAA..."    # From @BotFather (regex: /^\d{6,}:[\w-]{30,}$/)
BOT_MODE="webhook"                       # polling (dev) | webhook (prod)
TELEGRAM_WEBHOOK_SECRET="min16chars..."  # Required when BOT_MODE=webhook (min 16 chars)
ADMIN_TELEGRAM_IDS="1160085389"          # Comma-separated admin Telegram IDs

# ─── PVADeals Upstream ──────────────────────────────────────────
PVADEALS_API_KEY="API-..."               # Bearer token for PVADeals v3 (min 8 chars)
PVADEALS_BASE_URL="https://prod-v3.pvadeals.com"  # API base URL
PVADEALS_WEBHOOK_SECRET="min16chars..."  # Webhook secret (min 16 chars)

# ─── Supabase ───────────────────────────────────────────────────
SUPABASE_URL="https://xxx.supabase.co"   # Project URL
SUPABASE_SERVICE_ROLE_KEY="eyJ..."       # Service role key (NOT anon key) — min 20 chars
SUPABASE_ANON_KEY="eyJ..."              # Anon public key (for website JWT verification) — optional

# ─── NOWPayments (optional — leave blank to disable) ────────────
NOWPAYMENTS_API_KEY="..."                # API key (min 8 chars)
NOWPAYMENTS_IPN_SECRET="..."             # IPN secret (min 8 chars) — BOTH must be set
NOWPAYMENTS_BASE_URL="https://api.nowpayments.io"

# ─── Binance Personal API (optional — leave blank to disable) ───
BINANCE_API_KEY="..."                    # Personal API key with Wallet READ
BINANCE_API_SECRET="..."                 # Personal API secret
BINANCE_ID="..."                         # Your public Binance ID (shown to users)

# ─── bKash (optional — settings stored in DB via migration 006) ─
BKASH_APP_KEY="..."                      # bKash Merchant API (optional)
BKASH_APP_SECRET="..."
BKASH_USERNAME="..."
BKASH_PASSWORD="..."
BKASH_BASE_URL="https://tokenized.pay.bka.sh/v1.2.0-beta"
BKASH_NUMBER_SMALL="..."                 # bKash number for < limit TK
BKASH_NUMBER_LARGE="..."                 # bKash number for >= limit TK
BKASH_LIMIT_TK="500"                    # Threshold between numbers
BKASH_RATE_TK="130"                     # TK per $1 USD
BKASH_MIN_TK="390"                      # Minimum deposit in TK ($3)
BKASH_SMS_SECRET="..."                   # Webhook auth token for SMS forwarder
```

### Validation Rules (Zod)
- `BOT_MODE=webhook` requires `TELEGRAM_WEBHOOK_SECRET` (min 16) and `PUBLIC_BASE_URL` starting with `https://`
- `NOWPAYMENTS_API_KEY` and `NOWPAYMENTS_IPN_SECRET` must be set together (both or neither)
- `ADMIN_TELEGRAM_IDS` is parsed as CSV of positive integers
- Feature flags derived from env: `nowPaymentsEnabled()`, `binancePayEnabled()`, `bkashEnabled()`

---

## 6. Database Schema (Full SQL)

Run all migrations in order in the Supabase SQL Editor.

### Migration 001: Full Schema

```sql
-- PVADeals Bot — Full Database Schema

-- ─── Extensions ────────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ─── Enums ─────────────────────────────────────────────────────────────────────
create type price_mode as enum ('fixed', 'multiplier', 'markup');
create type plan_code  as enum ('STR','LTR3','LTR7','LTR14','LTR30','ALL_SERVICES_US','ALL_SERVICES_UK','REUSE');
create type order_status as enum ('PENDING_UPSTREAM','RESERVED','COMPLETED','EXPIRED','CANCELLED','REFUNDED','FAILED');
create type ledger_kind as enum ('purchase','reuse','refund','admin_credit','topup','adjustment');
create type topup_method as enum ('admin','nowpayments','voucher');
create type topup_status as enum ('pending','confirmed','failed');

-- ─── Profiles ──────────────────────────────────────────────────────────────────
create table profiles (
  id           uuid primary key default gen_random_uuid(),
  telegram_id  bigint not null unique,
  username     text,
  first_name   text not null,
  last_name    text,
  role         text not null default 'customer' check (role in ('customer', 'admin')),
  is_banned    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ─── Wallets ───────────────────────────────────────────────────────────────────
create table wallets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references profiles(id) on delete cascade,
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  updated_at    timestamptz not null default now()
);

-- ─── Services Cache ────────────────────────────────────────────────────────────
create table services_cache (
  id              uuid primary key default gen_random_uuid(),
  short_id        integer generated always as identity unique,
  service_id      text not null unique,
  name            text not null,
  country         text not null default 'USA',
  str_cost_cents  bigint not null default 0,
  ltr3_cost_cents bigint not null default 0,
  ltr7_cost_cents bigint not null default 0,
  ltr14_cost_cents bigint not null default 0,
  ltr30_cost_cents bigint not null default 0,
  str_stock       integer not null default 0,
  ltr_stock       integer not null default 0,
  synced_at       timestamptz not null default now()
);

-- ─── Plan Defaults ─────────────────────────────────────────────────────────────
create table plan_defaults (
  plan               plan_code primary key,
  mode               price_mode not null default 'multiplier',
  sell_cents         bigint,
  multiplier_bp      integer,
  markup_percent     numeric(6,2),
  markup_flat_cents  bigint,
  updated_at         timestamptz not null default now()
);

insert into plan_defaults (plan, mode, multiplier_bp) values
  ('STR',            'multiplier', 20000),
  ('LTR3',           'multiplier', 20000),
  ('LTR7',           'multiplier', 20000),
  ('LTR14',          'multiplier', 20000),
  ('LTR30',          'multiplier', 20000),
  ('ALL_SERVICES_US','multiplier', 20000),
  ('ALL_SERVICES_UK','multiplier', 20000),
  ('REUSE',          'fixed',      null)
on conflict (plan) do nothing;

update plan_defaults set sell_cents = 80 where plan = 'REUSE';

-- ─── Service Price Overrides ───────────────────────────────────────────────────
create table service_prices (
  id          uuid primary key default gen_random_uuid(),
  service_id  text not null,
  plan        plan_code not null,
  tier_id     uuid,
  sell_cents  bigint not null,
  note        text,
  updated_at  timestamptz not null default now()
);

create unique index service_prices_key_idx
  on service_prices(service_id, plan, coalesce(tier_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ─── Orders ────────────────────────────────────────────────────────────────────
create table orders (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id),
  service_id      text not null,
  service_name    text not null,
  plan            plan_code not null,
  sell_cents      bigint not null,
  cost_cents      bigint not null,
  status          order_status not null default 'PENDING_UPSTREAM',
  request_id      text,
  number          text,
  end_time        timestamptz,
  failure_reason  text,
  idempotency_key text not null unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index orders_user_id_idx on orders(user_id);
create index orders_request_id_idx on orders(request_id);
create index orders_status_idx on orders(status);

-- ─── Ledger Entries ────────────────────────────────────────────────────────────
create table ledger_entries (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id),
  amount_cents    bigint not null,
  kind            ledger_kind not null,
  balance_after   bigint not null,
  idempotency_key text not null unique,
  order_id        uuid references orders(id),
  note            text,
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now()
);

create index ledger_user_id_idx on ledger_entries(user_id);

-- ─── SMS Messages ──────────────────────────────────────────────────────────────
create table sms_messages (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references orders(id),
  user_id     uuid not null references profiles(id),
  request_id  text not null,
  number      text,
  body        text not null,
  received_at timestamptz not null default now()
);

create index sms_user_id_idx on sms_messages(user_id);
create index sms_request_id_idx on sms_messages(request_id);

-- ─── Top-ups ───────────────────────────────────────────────────────────────────
create table topups (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id),
  amount_cents  bigint not null,
  method        topup_method not null,
  status        topup_status not null default 'pending',
  external_id   text,
  note          text,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─── Webhook Events ────────────────────────────────────────────────────────────
create table webhook_events (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,
  event_type  text not null,
  dedupe_key  text not null unique,
  payload     jsonb not null,
  processed_at timestamptz not null default now()
);

-- ─── Settings (singleton) ──────────────────────────────────────────────────────
create table settings (
  id                        boolean primary key default true check (id),
  global_mode               price_mode not null default 'multiplier',
  global_fixed_cents        bigint,
  global_multiplier_bp      integer not null default 20000,
  global_markup_percent     numeric(6,2),
  global_markup_flat_cents  bigint,
  global_min_margin_cents   bigint not null default 1,
  reuse_cost_cents          bigint not null default 80,
  all_services_us_cost_cents bigint not null default 999,
  all_services_uk_cost_cents bigint not null default 699,
  purchases_enabled         boolean not null default true,
  maintenance_message       text,
  upstream_warn_cents       bigint not null default 1000,
  upstream_floor_cents      bigint not null default 100,
  allow_auto_renew          boolean not null default false,
  updated_at                timestamptz not null default now()
);

insert into settings (id) values (true);

-- ─── Functions ─────────────────────────────────────────────────────────────────

-- Auto-update updated_at trigger
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_profiles_updated_at   before update on profiles   for each row execute procedure touch_updated_at();
create trigger trg_wallets_updated_at    before update on wallets     for each row execute procedure touch_updated_at();
create trigger trg_orders_updated_at     before update on orders      for each row execute procedure touch_updated_at();
create trigger trg_settings_updated_at   before update on settings    for each row execute procedure touch_updated_at();
create trigger trg_topups_updated_at     before update on topups      for each row execute procedure touch_updated_at();

-- Debit wallet atomically (with idempotency)
-- SQLSTATE PVA01 = insufficient funds or invalid amount
-- SQLSTATE PVA02 = wallet not found
create or replace function debit_wallet(
  p_user_id         uuid,
  p_amount_cents    bigint,
  p_kind            ledger_kind,
  p_idempotency_key text,
  p_order_id        uuid default null,
  p_note            text default null,
  p_created_by      uuid default null
) returns bigint language plpgsql as $$
declare
  v_balance      bigint;
  v_balance_after bigint;
  v_existing     bigint;
begin
  select balance_after into v_existing
    from ledger_entries where idempotency_key = p_idempotency_key;
  if found then return v_existing; end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid amount' using errcode = 'PVA01';
  end if;

  select balance_cents into v_balance
    from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found' using errcode = 'PVA02';
  end if;

  if v_balance < p_amount_cents then
    raise exception 'insufficient funds' using errcode = 'PVA01';
  end if;

  v_balance_after := v_balance - p_amount_cents;
  update wallets set balance_cents = v_balance_after where user_id = p_user_id;

  insert into ledger_entries
    (user_id, amount_cents, kind, balance_after, idempotency_key, order_id, note, created_by)
  values
    (p_user_id, -p_amount_cents, p_kind, v_balance_after, p_idempotency_key, p_order_id, p_note, p_created_by);

  return v_balance_after;
end;
$$;

-- Credit wallet atomically (with idempotency)
create or replace function credit_wallet(
  p_user_id         uuid,
  p_amount_cents    bigint,
  p_kind            ledger_kind,
  p_idempotency_key text,
  p_topup_id        uuid default null,
  p_note            text default null,
  p_created_by      uuid default null
) returns bigint language plpgsql as $$
declare
  v_balance_after bigint;
  v_existing      bigint;
begin
  select balance_after into v_existing
    from ledger_entries where idempotency_key = p_idempotency_key;
  if found then return v_existing; end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid amount' using errcode = 'PVA01';
  end if;

  select balance_cents into v_balance_after
    from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found' using errcode = 'PVA02';
  end if;

  v_balance_after := v_balance_after + p_amount_cents;
  update wallets set balance_cents = v_balance_after where user_id = p_user_id;

  insert into ledger_entries
    (user_id, amount_cents, kind, balance_after, idempotency_key, note, created_by)
  values
    (p_user_id, p_amount_cents, p_kind, v_balance_after, p_idempotency_key, p_note, p_created_by);

  return v_balance_after;
end;
$$;

-- Upsert Telegram user + wallet atomically
create or replace function upsert_telegram_user(
  p_telegram_id bigint,
  p_username    text,
  p_first_name  text,
  p_last_name   text default null
) returns json language plpgsql as $$
declare
  v_profile profiles%rowtype;
begin
  insert into profiles (telegram_id, username, first_name, last_name)
  values (p_telegram_id, p_username, p_first_name, p_last_name)
  on conflict (telegram_id) do update set
    username   = excluded.username,
    first_name = excluded.first_name,
    last_name  = excluded.last_name,
    updated_at = now()
  returning * into v_profile;

  insert into wallets (user_id) values (v_profile.id)
  on conflict (user_id) do nothing;

  return row_to_json(v_profile);
end;
$$;

-- ─── Row Level Security ────────────────────────────────────────────────────────
alter table profiles         enable row level security;
alter table wallets          enable row level security;
alter table services_cache   enable row level security;
alter table plan_defaults    enable row level security;
alter table service_prices   enable row level security;
alter table orders           enable row level security;
alter table ledger_entries   enable row level security;
alter table sms_messages     enable row level security;
alter table topups           enable row level security;
alter table webhook_events   enable row level security;
alter table settings         enable row level security;
```

### Migration 002: is_renewed flag

```sql
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_renewed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_orders_expired_reserved
  ON orders (status, end_time, is_renewed)
  WHERE status = 'RESERVED';
```

### Migration 003: purchase_msg_id

```sql
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS purchase_msg_id bigint;
```

### Migration 004: Binance Pay enum

```sql
ALTER TYPE topup_method ADD VALUE IF NOT EXISTS 'binancepay';
```

### Migration 005: bKash + Nagad enum

```sql
ALTER TYPE topup_method ADD VALUE IF NOT EXISTS 'bkash';
ALTER TYPE topup_method ADD VALUE IF NOT EXISTS 'nagad';
```

### Migration 006: Payment settings

```sql
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS bkash_number    TEXT    DEFAULT '01799424191',
  ADD COLUMN IF NOT EXISTS bkash_rate_tk   INT     DEFAULT 130,
  ADD COLUMN IF NOT EXISTS bkash_min_tk    INT     DEFAULT 390,
  ADD COLUMN IF NOT EXISTS bkash_enabled   BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS nagad_number    TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS nagad_rate_tk   INT     DEFAULT 130,
  ADD COLUMN IF NOT EXISTS nagad_min_tk    INT     DEFAULT 390,
  ADD COLUMN IF NOT EXISTS nagad_enabled   BOOLEAN DEFAULT false;

UPDATE settings SET bkash_number = '01799424191' WHERE bkash_number IS NULL OR bkash_number = '';
```

### Migration 007: Web auth

```sql
-- Link profiles to Supabase Auth users
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS link_code TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS link_code_expires TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_auth_user_id ON profiles (auth_user_id) WHERE auth_user_id IS NOT NULL;

-- Auto-create profile + wallet when new Supabase Auth user signs up
CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (auth_user_id, first_name, username)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)), NEW.email)
  ON CONFLICT (auth_user_id) DO NOTHING;

  INSERT INTO wallets (user_id, balance_cents)
  SELECT id, 0 FROM profiles WHERE auth_user_id = NEW.id
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

-- RLS policies for website frontend (anon key access)
CREATE POLICY IF NOT EXISTS "Users read own profile"
  ON profiles FOR SELECT
  USING (auth_user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "Users read own wallet"
  ON wallets FOR SELECT
  USING (user_id IN (SELECT id FROM profiles WHERE auth_user_id = auth.uid()));

CREATE POLICY IF NOT EXISTS "Users read own orders"
  ON orders FOR SELECT
  USING (user_id IN (SELECT id FROM profiles WHERE auth_user_id = auth.uid()));
```

---

## 7. Core Domain Logic

### Money (`domain/money.ts`)
- **All amounts are integer cents** (bigint in DB, number in JS)
- `toCents(dollars)` — converts upstream float → integer cents (uses toFixed(6) to trim binary noise)
- `formatCents(cents)` — display: 130 → "$1.30"
- `ceilCents(value)` — ceiling-round fractional cents

### Wallet (`domain/wallet.ts`)
- `debitWallet(db, opts)` — calls `debit_wallet()` PG function. Throws `InsufficientFundsError` (PVA01) or `WalletNotFoundError` (PVA02)
- `creditWallet(db, opts)` — calls `credit_wallet()` PG function
- `getBalanceCents(db, telegramId)` — reads wallet via `profiles!inner(telegram_id)` join
- Both functions are **idempotent** via `idempotency_key` — double-taps collapse to one charge

### Pricing (`domain/pricing.ts`)
- **Three-level cascade:**
  1. `service_prices` table — explicit per-service override
  2. `plan_defaults` table — per-plan rule
  3. `settings` table — global rule
- **Price modes:** `fixed` (exact cents), `multiplier` (basis points, 20000 = ×2.00), `markup` (percent + flat)
- Floor: `sellCents >= costCents + minMarginCents` always enforced
- `extractOtp(body)` — regex to pull OTP code from SMS text

### Orders (`domain/orders.ts`)
- Status enum: `PENDING_UPSTREAM → RESERVED → COMPLETED → EXPIRED | CANCELLED | REFUNDED | FAILED`
- `createOrder()`, `updateOrderSuccess()`, `updateOrderFailed()`, `getPendingOrders()`, `getOrdersByUser()`

---

## 8. PVADeals Upstream API Client

### Critical API Notes (from `upstream/client.ts`)
- **Auth:** `Authorization: Bearer <key>` (NOT x-api-key)
- **STR purchase:** `POST /v3/api/purchase` body: `{services:[{serviceId, areaCode?}]}` (array, not flat)
- **LTR purchase:** `POST /v3/api/purchase-ltr` body: `{serviceId, duration, areaCode?}`
- **ALL_SERVICES US:** `POST /v3/api/purchase-ltr` body: `{serviceId:"ALL_SERVICES", country:"US"}`
- **ALL_SERVICES UK:** `POST /v3/api/purchase-ltr` body: `{serviceId:"ALL_SERVICES", country:"UK"}`
- **Flag:** `POST /v3/api/flag/{id}`
- **Reuse:** `POST /v3/api/reuse/{id}`
- **Renew LTR:** `POST /v3/api/renew-ltr/{id}`
- **Change duration preview:** `GET /v3/api/ltr-change-duration/{id}/preview?duration=N`
- **Change duration commit:** `POST /v3/api/ltr-change-duration/{id}` body: `{duration:N}`
- **List requests:** `GET /v3/api/requests?first=N&after=cursor&orderBy=desc` → `data.data.edges[].node`
- **Get single request:** `GET /v3/api/request/{id}`
- **Get service:** `GET /v3/api/service/{id}` — STR price key is `price` (not `STRprice`)
- **List all services:** `GET /v3/api/services/all` → `data.services[]`
- **Balance:** `GET /v3/api/balance` → `data.credits`
- **Health:** `GET /v3/api/health` — UNWRAPPED response (no envelope), returns `{status: "operational"}`

### Rate Limits (calls/60s per key)
| Endpoint | Limit |
|----------|-------|
| services_all | 10 |
| purchase_ltr | 30 |
| flag_reuse_renew | 30 |
| purchase | 50 |
| balance | 60 |
| requests | 60 |
| service_by_id | 60 |
| request_by_id | 120 |
| default | 120 |

### Circuit Breaker
- Threshold: 8 consecutive failures
- Recovery: 5 minutes (all purchases blocked)
- States: closed → open → half-open (one probe)

### Health Gate
- Polls `/v3/api/health` every 30 seconds
- Blocks all purchases when `status !== "operational"`

---

## 9. Telegram Bot

### Middleware Pipeline
1. **sequentialize** — serializes updates per chat ID (prevents purchase races)
2. **userMiddleware** — upserts user via `upsert_telegram_user()` PG function, checks ban, injects `ctx.user`, `ctx.db`, `ctx.pva`, `ctx.env`. Rate limits (500ms cooldown per user). Auto-answers callback queries.

### Commands
| Command | Handler | Description |
|---------|---------|-------------|
| `/start`, `/main` | `handleStart` | Welcome message + balance + main menu |
| `/search <query>` | `handleServiceSearch` | Search services by name |
| `/logs` | `handleLogsMenu` | SMS/number/payment logs |
| `/menu` | — | Shows main menu keyboard |
| `/admin` | `handleAdminMenu` | Admin dashboard (gated) |
| `/status` | `handleAdminStatus` | Upstream status detail |
| `/users` | `handleAdminUsers` | Paginated user list |
| `/setplan STR 0.18` | `handleSetPlan` | Set plan price (fixed/multiplier/markup) |
| `/setreuse 0.80` | `handleSetReuse` | Set reuse price |
| `/setglobal x2.00` | `handleSetGlobal` | Set global pricing rule |
| `/credit <tid> <amt> <note>` | `handleAdminCredit` | Credit user wallet |
| `/ban <tid>` / `/unban <tid>` | `handleAdminBan` | Ban/unban user |
| `/broadcast <text>` | `handleBroadcast` | DM all non-banned users (25/s throttle) |
| `/exportcsv` | `handleExportCsv` | Download price overrides CSV |

### Callback Actions (64-byte encoded as `ACTION:PARAM1:PARAM2`)
`HOME`, `SVC_LIST`, `SVC_VIEW`, `SVC_DET`, `SVC_SRCH`, `BUY_STR/LTR3/LTR7/LTR14/LTR30`, `BUY_ALL_US/UK`, `BUY_CFM`, `NUM_LIST`, `NUM_VIEW`, `ACT_REUSE`, `ACT_REUSE_CFM`, `ACT_FLAG`, `ACT_RENEW`, `ACT_RENEW_CFM`, `ACT_AUTO`, `ACT_DUR`, `ACT_DUR_CFM`, `TOPUP`, `TOPUP_ENTER`, `BINANCE_ENTER`, `BKASH_ENTER`, `BK_APR/BK_REJ`, `NAGAD_ENTER`, `NG_APR/NG_REJ`, `LOG_MENU`, `LOG_SMS/NUM/PAY`, `ADM_MAIN/PRICE/USERS/STATUS`

### Text Message Routing
Text replies are detected via **ForceReply markers** embedded in the prompt message:
- `TOPUP_PROMPT_MARKER` → NOWPayments amount
- `BINANCE_NAME_MARKER` → Binance display name (step 2)
- `BINANCE_AMOUNT_PREFIX` → Binance USDT amount (step 3, name encoded in marker)
- `BKASH_TRXID_MARKER` → bKash Transaction ID (step 2)
- `BKASH_AMOUNT_PREFIX` → bKash TK amount (step 3, trxId encoded in marker)
- `NAGAD_TRXID_MARKER` → Nagad Transaction ID (step 2)
- `NAGAD_AMOUNT_PREFIX` → Nagad TK amount (step 3, trxId encoded in marker)
- Otherwise → treated as service search

### Purchase Flow (buy.ts)
1. `handleBuyConfirm`: Show price + balance + confirm button
2. `handleBuyExecute`: Idempotency key = `ctx.callbackQuery.id`
   - Check upstream health + breaker
   - `debitWallet` (idempotent)
   - `createOrder` (PENDING_UPSTREAM)
   - Call upstream API
   - Success: `updateOrderSuccess` + notify user (save `purchase_msg_id` for OTP threading)
   - Failure: `updateOrderFailed` + `creditWallet` refund + notify user

### Service Browsing (browse.ts)
- Paginated (8 per page), deduplicated by name (US+UK variants merged)
- Dual-country services show country picker first, then detail
- Search supports ILIKE matching
- Sell prices computed live via three-level pricing cascade

---

## 10. Payment Integrations

### NOWPayments (Crypto)
- **Create invoice:** `POST /v1/invoice` with `x-api-key` header
- `order_id` format: `userId:amountCents:timestamp`
- User opens `invoice_url` → picks crypto → pays
- **IPN webhook:** `POST /webhooks/nowpayments` — HMAC-SHA512 verified (alphabetically sorted JSON)
- Credits wallet on `payment_status: "finished" | "confirmed"`
- Min top-up: $3.00

### Binance Pay (USDT)
- Uses **personal account API** (`GET /sapi/v1/pay/transactions`) — NOT merchant API
- 3-step flow: Show Binance ID → User enters display name → User enters USDT amount → Verify via API → Credit wallet
- Match: USDT currency + sender name (fuzzy) + amount (±$0.05) within 45-min window
- HMAC-SHA256 signature for Binance API auth

### bKash (BDT)
- 3-step flow: Show number → User enters TrxID → User enters TK amount → Save pending → Notify admin
- Admin Approve/Reject via inline buttons (callback: `BK_APR`/`BK_REJ`)
- Auto-credit via SMS webhook: `POST /webhooks/bkash-sms` — parses bKash SMS text, matches TrxID to pending topup
- SMS parser regex: `Tk 250.00 received from... Ref ABC1234XYZ`
- Rate: configurable TK per $1 (default 130)

### Nagad (BDT)
- Identical flow to bKash but with `NAGAD_ENTER`, `NG_APR`/`NG_REJ` callbacks
- Separate settings in DB (nagad_number, nagad_rate_tk, nagad_min_tk, nagad_enabled)

### CryptoPay (@CryptoBot) — prepared but not active
- Invoice via `POST /api/createInvoice` with `Crypto-Pay-API-Token` header
- Webhook verification: HMAC-SHA256 of raw body using SHA256 hash of token as secret

---

## 11. Background Jobs

### CatalogSync (45s interval)
- Fetches `GET /v3/api/services/all` from PVADeals
- Upserts into `services_cache` table (key: `service_id`)
- Converts upstream float prices to integer cents
- Skips if upstream unhealthy

### BalanceWatch (60s interval)
- Reads upstream balance via `GET /v3/api/balance`
- Below `upstream_warn_cents` → DM all admins warning
- Below `upstream_floor_cents` → Auto-disable `purchases_enabled` in settings + DM admins
- Recovery: when balance recovers above floor, re-enables purchases + notifies

### ReconcileSweep (three sub-jobs)
1. **Crash Recovery (90s):** Finds `PENDING_UPSTREAM` orders older than 90s, checks upstream for matching request, heals or refunds
2. **Expired Without OTP (5min):**
   - STR RESERVED > 21 min → refund + EXPIRED + DM user
   - LTR RESERVED past end_time, `is_renewed=false` → refund + EXPIRED
   - LTR RESERVED past end_time, `is_renewed=true` → EXPIRED only (no refund)
3. **STR Reuse Expiry (2min):** Finds `reuse` ledger entries > 10 min old with no SMS received in that window → refund $0.80

---

## 12. REST API (Website)

All endpoints require `Authorization: Bearer <supabase_jwt>`. Auth verifies JWT via Supabase anon client, then looks up profile by `auth_user_id`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/me` | Profile + balance + recent topups |
| GET | `/api/services` | Full catalog with computed sell prices |
| GET | `/api/services/:id` | Single service detail with prices |
| POST | `/api/buy` | Purchase number (body: `{service_id, plan}`) |
| GET | `/api/orders` | User's orders (last 50) |
| GET | `/api/orders/:id/sms` | SMS messages for an order |
| POST | `/api/topup/bkash` | Submit bKash payment (body: `{trx_id, amount_tk}`) |
| POST | `/api/topup/nagad` | Submit Nagad payment (body: `{trx_id, amount_tk}`) |
| POST | `/api/topup/crypto` | Create NOWPayments invoice (body: `{amount_usd}`) |
| GET | `/api/payment-settings` | Get enabled payment methods + settings |
| POST | `/api/link-telegram` | Generate 6-digit code for Telegram linking |

CORS enabled with `origin: true, credentials: true`.

---

## 13. Webhook Handlers

### `POST /webhooks/telegram/{secret}`
- grammY webhook callback with secret token verification
- Registered regardless of bot mode (ready for switch)

### `POST /webhooks/nowpayments`
- HMAC-SHA512 signature verification via `x-nowpayments-sig` header
- Calls `processNowPaymentsIpn()` → credits wallet on confirmed status

### `POST /webhooks/bkash-sms?secret=BKASH_SMS_SECRET`
- Accepts `{text}` or `{message}` or `{body}` or `{sms}` field
- Parses bKash "Send Money received" SMS → matches TrxID to pending topup → auto-credits wallet → notifies user via Telegram

### `POST /webhooks/pvadeals/{secret}`
- Handles three event types:
  - `sms_received`: Stores SMS, marks order COMPLETED, sends OTP to user (replies to purchase message)
  - `number_renewed`: Updates order `request_id` + `end_time`
  - `number_flagged`: Marks order CANCELLED

### `GET /health`
- Returns `{ok: true, mode: "webhook"|"polling"}`

---

## 14. Server Entry Point (`src/index.ts`)

### Startup Sequence
1. Load + validate env vars via Zod
2. Create Supabase client (service_role key)
3. Create PVADeals client
4. Create grammY bot
5. Register Fastify plugins: CORS, raw body parser
6. Register routes: REST API, health, webhooks (NOWPayments, bKash SMS, Telegram, PVADeals)
7. Start background services: Health gate, CatalogSync, ReconcileSweep, BalanceWatch
8. Start bot: polling mode (dev) or register webhook (prod)
9. Listen on `0.0.0.0:PORT`

### Shutdown
- Listens for SIGINT/SIGTERM
- Stops health gate, closes Fastify server

### Raw Body Parser
Custom content type parser preserves raw buffer for signature verification while still parsing JSON for handler use.

---

## 15. Build & Deployment

### Docker (2-stage build)
```dockerfile
# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Production
FROM node:22-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --frozen-lockfile
COPY --from=builder /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

### Railway Config (`railway.toml`)
```toml
[build]
builder = "dockerfile"

[deploy]
startCommand = "node dist/index.js"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 5
```

### NPM Scripts
```json
{
  "dev": "tsx watch --clear-screen=false src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js",
  "typecheck": "tsc --noEmit"
}
```

---

## 16. Configuration Files

### TypeScript (`tsconfig.json`)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": false,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Dependencies (`package.json`)
```json
{
  "name": "pvadeals-bot",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {"node": ">=20"},
  "dependencies": {
    "@fastify/cors": "^11.3.0",
    "@grammyjs/runner": "^2.0.3",
    "@supabase/supabase-js": "^2.48.1",
    "dotenv": "^16.4.7",
    "fastify": "^5.2.1",
    "grammy": "^1.34.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.7",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3"
  }
}
```

### Important Design Decisions
1. **ESM-only** — all imports use `.js` extension (TypeScript NodeNext resolution)
2. **No session store** — state passed via ForceReply markers and callback_data encoding
3. **Idempotency everywhere** — callback_query.id for purchases, payment_id for topups, trxId for bKash
4. **HTML parse mode** — never MarkdownV2 (service names contain special chars)
5. **Service-role only** — bot uses Supabase service_role key, RLS is backstop only
6. **Anon key for website** — REST API verifies JWTs via anon Supabase client
7. **Money as cents** — never use floats for money, convert at edges only
8. **Views as tables** — `services_cache` aliased as `catalog` in API routes (may need a DB view)

---

## END OF SPECIFICATION

This document contains every single detail of the project. With this spec + the PVADeals API documentation, any developer or AI can rebuild the entire system from scratch.
