-- PVADeals Bot — Full Database Schema
-- Apply via: psql $DATABASE_URL -f supabase/migrations/001_init.sql
-- Or via Supabase dashboard SQL editor

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
  short_id        integer generated always as identity unique, -- for callback_data
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
-- One rule per plan — global default applied to all services of that plan type
create table plan_defaults (
  plan               plan_code primary key,
  mode               price_mode not null default 'multiplier',
  sell_cents         bigint,           -- fixed override (takes priority over rule)
  multiplier_bp      integer,          -- basis points (2000 = ×2.00)
  markup_percent     numeric(6,2),
  markup_flat_cents  bigint,
  updated_at         timestamptz not null default now()
);

-- Seed plan defaults (×2.00 for all plans)
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

-- REUSE: admin sets a flat price, not a multiplier
update plan_defaults set sell_cents = 80 where plan = 'REUSE';

-- ─── Service Price Overrides ───────────────────────────────────────────────────
-- Per-service, per-plan overrides. tier_id is reserved for future per-tier pricing.
-- No FK to services_cache so an override survives a catalog resync.
create table service_prices (
  id          uuid primary key default gen_random_uuid(),
  service_id  text not null,
  plan        plan_code not null,
  tier_id     uuid,   -- null = all customers
  sell_cents  bigint not null,
  note        text,
  updated_at  timestamptz not null default now()
);

-- coalesce() in a unique constraint requires a separate index (not inline unique())
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
  request_id      text,           -- upstream requestId
  number          text,           -- assigned phone number
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
  external_id   text,           -- NOWPayments payment_id
  note          text,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─── Webhook Events (dedup log) ────────────────────────────────────────────────
create table webhook_events (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,         -- 'pvadeals' | 'nowpayments'
  event_type  text not null,
  dedupe_key  text not null unique,  -- prevents reprocessing on retry
  payload     jsonb not null,
  processed_at timestamptz not null default now()
);

-- ─── Settings (singleton row) ──────────────────────────────────────────────────
create table settings (
  id                        boolean primary key default true check (id),
  global_mode               price_mode not null default 'multiplier',
  global_fixed_cents        bigint,
  global_multiplier_bp      integer not null default 20000,   -- ×2.00
  global_markup_percent     numeric(6,2),
  global_markup_flat_cents  bigint,
  global_min_margin_cents   bigint not null default 1,
  reuse_cost_cents          bigint not null default 80,        -- $0.80 reuse
  all_services_us_cost_cents bigint not null default 999,      -- $9.99 upstream
  all_services_uk_cost_cents bigint not null default 699,      -- $6.99 upstream
  purchases_enabled         boolean not null default true,
  maintenance_message       text,
  upstream_warn_cents       bigint not null default 1000,      -- $10.00 warn
  upstream_floor_cents      bigint not null default 100,       -- $1.00 pause
  allow_auto_renew          boolean not null default false,
  updated_at                timestamptz not null default now()
);

insert into settings (id) values (true);

-- ─── Functions ─────────────────────────────────────────────────────────────────

-- Auto-update updated_at
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

-- Debit wallet atomically
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
  -- Idempotency fast-path
  select balance_after into v_existing
    from ledger_entries where idempotency_key = p_idempotency_key;
  if found then return v_existing; end if;

  -- Validate amount
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid amount' using errcode = 'PVA01';
  end if;

  -- Lock wallet row
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

-- Credit wallet atomically
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
  -- Idempotency fast-path
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

  -- Create wallet if not exists
  insert into wallets (user_id) values (v_profile.id)
  on conflict (user_id) do nothing;

  return row_to_json(v_profile);
end;
$$;

-- ─── Row Level Security ────────────────────────────────────────────────────────
-- All access goes through the service_role client — RLS is a backstop only.
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
