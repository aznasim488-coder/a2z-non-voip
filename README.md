# PVADeals Reseller Bot

A production-ready Telegram bot for reselling virtual phone numbers via the [PVADeals](https://pvadeals.com) API.

## Features

- 📱 Browse & buy STR (20-min) and LTR (3/7/14/30-day) phone numbers
- 💳 Pre-funded wallet with idempotent debit/credit
- 🔄 Free OTP requests during active LTR rental; $0.80 per STR reuse
- 🚩 Flag bad numbers (before OTP received only)
- 🔁 Renew LTR numbers with warning + wallet charge
- ⬆️ Upgrade LTR duration (non-refundable warning)
- 🟢 Auto-renew toggle (UI preference stored in DB)
- 📊 SMS Logs, Number Logs, Payment Logs with pagination
- 🛡️ Admin panel — pricing, users, credit, ban, broadcast
- ⚡ Webhook mode for instant response (~100ms)
- 🔒 Rate limiting, circuit breaker, idempotency

## Tech Stack

| Layer | Tech |
|-------|------|
| Bot | grammY + TypeScript |
| HTTP | Fastify |
| DB | Supabase (PostgreSQL) |
| Runtime | Node.js 20+ |
| Deploy | Railway / Fly.io |

## Quick Start

### 1. Clone & install
```bash
git clone https://github.com/YOUR_USERNAME/pvadeals-bot.git
cd pvadeals-bot
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Set up Supabase
1. Create a new Supabase project
2. Go to **SQL Editor** and run the full schema:
   ```
   supabase/migrations/001_init.sql
   ```
3. Then run the additional migration:
   ```sql
   ALTER TABLE orders ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT false;
   ```

### 4. Set PVADeals webhook URL
In your PVADeals dashboard, set the webhook URL to:
```
https://your-domain.com/webhooks/pvadeals/<PVADEALS_WEBHOOK_SECRET>
```

### 5. Run locally
```bash
npm run dev
```

## Deploy to Railway

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Add all environment variables from `.env.example` (with production values)
4. Set these for production:
   ```
   BOT_MODE=webhook
   PUBLIC_BASE_URL=https://your-app.up.railway.app
   NODE_ENV=production
   PORT=3001
   ```
5. Railway will auto-build and deploy

## Environment Variables

See [`.env.example`](.env.example) for all required variables.

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `ADMIN_TELEGRAM_IDS` | ✅ | Comma-separated admin Telegram IDs |
| `PVADEALS_API_KEY` | ✅ | PVADeals reseller API key |
| `PVADEALS_WEBHOOK_SECRET` | ✅ | Random string (min 16 chars) for webhook URL |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service_role key (not anon) |
| `BOT_MODE` | ✅ | `polling` (dev) or `webhook` (prod) |
| `PUBLIC_BASE_URL` | webhook | HTTPS URL of your server |
| `TELEGRAM_WEBHOOK_SECRET` | webhook | Random string (min 16 chars) |
| `NOWPAYMENTS_API_KEY` | ❌ | Optional crypto top-ups |

## Bot Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/start` | All | Main menu |
| `/search <name>` | All | Search services |
| `/logs` | All | View SMS/transaction logs |
| `/admin` | Admin | Admin panel |
| `/credit <tid> <amount> <note>` | Admin | Add balance to user |
| `/ban <tid>` / `/unban <tid>` | Admin | Ban/unban user |
| `/setplan <PLAN> <price>` | Admin | Set plan pricing |
| `/broadcast <message>` | Admin | Broadcast to all users |

## Pricing Rules (3-level cascade)

1. **Service override** (`service_prices` table) — highest priority
2. **Plan default** (`plan_defaults` table) — per plan type
3. **Global rule** (`settings` table) — fallback

All modes: `fixed` | `multiplier` (×2.00 default) | `markup` (+% + flat)

Floor: `sell_price ≥ cost + $0.01` always enforced.

## License

Private — not for redistribution.
