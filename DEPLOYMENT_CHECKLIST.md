# Deployment Checklist

Use this before promoting the platform to production or a live pilot.
Assumes the bundled Docker Compose topology on a VPS (`docker-compose.yml` +
`deploy/nginx/propfirm.conf`).

For a full readiness assessment with scores and known gaps, see
[DEPLOYMENT_READINESS_REPORT.md](DEPLOYMENT_READINESS_REPORT.md).

---

## 0. Before anything else

- [ ] Working tree is committed. A clean `git clone` must contain every migration
      and every file `server.js` requires, or the container will not boot.
- [ ] `cp .env.template .env` and fill in every value marked REQUIRED.
- [ ] Generate each secret — do not hand-write them:
      `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      `backend/env.js` rejects anything under 32 chars or matching
      `/your-|changeme|change-me|example|placeholder|password|default/i`.

## 1. Required environment

Hard-required in production (`REQUIRED_IN_PROD` in `backend/env.js` — startup
calls `process.exit(1)` if any is missing):

- [ ] `DATABASE_URL`
- [ ] `JWT_SECRET`
- [ ] `ADMIN_JWT_SECRET`
- [ ] `ADMIN_PASSWORD`
- [ ] `KYC_FILE_ENCRYPTION_KEY`

Also set:

- [ ] `NODE_ENV=production`
- [ ] `FRONTEND_URL` — **this drives the CORS allowlist.** There is no
      `CORS_ORIGINS` variable; `utils/allowedOrigins.js` reads `FRONTEND_URL`
      plus optional comma-separated `ALLOWED_ORIGINS`. Earlier revisions of this
      checklist named the wrong variable.
- [ ] `TRUST_PROXY=1` behind the bundled nginx (one hop). Increase only if you
      add another proxy in front, e.g. Cloudflare.
- [ ] `VITE_API_URL=` — **must stay empty.** It is the frontend's axios baseURL
      and every request path already begins with `/api/...`, so behind the
      same-origin nginx proxy an empty value is correct. A value here produces
      `/api/api/...` and breaks every request.
- [ ] `REDIS_URL`
- [ ] `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- [ ] `TOTP_ENCRYPTION_KEY`
- [ ] `FIRM_NAME`, `PLATFORM_NAME`
- [ ] `PRICE_HISTORY_RETAIN_DAYS`, `PRICE_HISTORY_1H_RETAIN_DAYS`
- [ ] `MT5_BRIDGE_PATH` (host path), `DWX_PATH=/app/mt5-bridge` (container path)
- [ ] `SENTRY_DSN` (backend) and `FRONTEND_SENTRY_DSN` (baked into the SPA at
      build time) — strongly recommended, not required.

## 2. TLS

- [ ] Issue certs into `deploy/certs/` as `fullchain.pem` + `privkey.pem`
      **before** starting nginx, which claims port 80. See
      `deploy/certs/.gitkeep` for the certbot standalone command.
- [ ] Confirm renewal is on a cron, followed by `docker compose restart nginx`.

## 3. Admin access

- [ ] Create at least one active DB-backed platform admin in `platform_admins`.
- [ ] Enroll TOTP 2FA for **every** platform admin. `deploy-preflight` fails in
      strict mode if any active admin lacks it.
- [ ] Confirm production env-fallback admin login is disabled.
- [ ] Rotate `ADMIN_PASSWORD` after bootstrap; it must not be a working
      day-to-day credential.
- [ ] Confirm `/api/admin/security/status` reports DB-backed admin migration
      complete and 2FA coverage complete.

## 4. Database and migrations

- [ ] Migrations run in the dedicated one-shot `migrate` compose service, which
      `backend` waits on via `service_completed_successfully`. Do **not** move
      them back into the backend's `CMD` — that races itself once you scale.
- [ ] `docker compose run --rm migrate` and confirm it exits 0.
- [ ] Confirm indexes exist for price history, candles, account lists, KYC
      queues, payout queues, and email jobs (migration 002 + 006).
- [ ] Verify backup **and restore** before accepting real users. An untested
      backup is not a backup.

> Known gap: ~260 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` statements still
> live in application code outside `migrations/`. A clean `migrate:status` is
> therefore not proof the schema is complete. Tracked in the readiness report.

## 5. Preflight gate

```bash
cd backend
npm run deploy:preflight     # must print "Deployment preflight passed."
```

This checks required + unsafe env vars, pending migrations, and admin/2FA
coverage. It is strict automatically when `NODE_ENV=production`. **Do not deploy
on a FAIL.**

## 6. KYC storage

- [ ] `KYC_FILE_ENCRYPTION_KEY` set; new uploads are encrypted at rest.
- [ ] KYC documents remain behind authenticated endpoints only (`/uploads` is
      admin-gated with a path-traversal guard; traders reach their own documents
      via `GET /api/kyc/document/:type`).
- [ ] Move encrypted files to private object storage before larger scale.

## 7. Email

- [ ] Verified sender domain via Brevo, Resend, or equivalent. `env.js` flags
      `SMTP_FROM` as unsafe if it equals `SMTP_USER` or uses an ESP technical
      domain (`sendgrid.net`, `smtp-brevo.com`, `mailgun.org`, `amazonses.com`).
- [ ] Smoke-test forgot-password, KYC-submitted, and payout notification.
- [ ] The `email-worker` service is running (it is a separate compose service).
- [ ] Admin email-jobs page shows queued / sent / retry / failed / dead states.

## 8. Price feed — read this before choosing your host

The feed is **file-based only**. `priceFeed.js` reads DWX text files, and
`price_feed_sources.source_type` accepts exactly `shared_env` and `dwx_path`.
**There is no HTTP or WebSocket market-data provider anywhere in the codebase.**

The backend container is `node:20-alpine` and contains no MetaTrader. So:

- [ ] A MetaTrader 5 terminal runs **outside** these containers — a Windows host
      or Wine — with the DWX expert advisor attached.
- [ ] It writes `DWX_Market_Data.txt`, `DWX_Commands_0.txt`, and
      `DWX_History_Export.json` into the host directory named by
      `MT5_BRIDGE_PATH`.
- [ ] That directory is bind-mounted into the backend at `/app/mt5-bridge`
      (read-write — the backend writes command files to subscribe to symbols).
- [ ] Confirm ticks are flowing for every enabled symbol **before** enabling
      trading.
- [ ] Confirm stale-feed alerts are visible to admins.

This is the single biggest constraint on deployment topology, and the reason a
pure managed-PaaS deploy (Render, Railway, Fly) is not viable without first
building an HTTP price-source adapter.

## 9. Trading smoke tests

Run manually against the live stack, in order:

- [ ] register → KYC upload → challenge purchase (Stripe test mode)
- [ ] market order open
- [ ] pending order create → trigger
- [ ] SL close, TP close, manual close, partial close
- [ ] drawdown breach → account fails
- [ ] profit target → account passes
- [ ] news-window block, and confirm close/reduce-risk actions stay allowed
- [ ] payout request → admin approve

`npm run launch:smoke` covers part of this automatically; the rest is manual.

## 10. Verification commands

```bash
cd backend
npm run lint
npm run check                # node --check on the four largest files
npm test                     # 89/89
npm audit --audit-level=high # must be clean

cd ../frontend
npm run lint
npm test                     # 32/32
npm run build
npm audit --audit-level=high # must be clean

# Config validation (needs Docker — run on the VPS)
docker compose config
docker compose run --rm nginx nginx -t
```

## 11. Post-start verification

- [ ] `/api/health` returns `launch_ready: true`
- [ ] All service healthchecks green (`docker compose ps`)
- [ ] Socket.IO connects from the browser (live prices tick on the terminal)
- [ ] Backup cron installed (`0 2 * * * /opt/propfirm/scripts/backup.sh`)

## Go / No-Go

Do **not** go live if any of the following is true:

- tests fail, or lint fails
- `npm audit --audit-level=high` is non-clean on either package
- `npm run deploy:preflight` does not pass
- admin 2FA coverage is incomplete
- database restore has not been tested
- the price feed is stale or not flowing
