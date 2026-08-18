# Deployment Checklist

Bundled Docker Compose topology on a VPS (`docker-compose.yml` +
`deploy/nginx/propfirm.conf`). For a readiness assessment with scores and known
gaps, see [DEPLOYMENT_READINESS_REPORT.md](DEPLOYMENT_READINESS_REPORT.md).

---

## The short version

```bash
git clone <repo> /opt/propfirm && cd /opt/propfirm
./deploy.sh --domain trade.example.com --email you@example.com
```

That is the whole deploy. It generates `.env` with real secrets, issues TLS
certificates, provisions the database, starts every service, seeds the platform,
creates the bootstrap admin, and runs the preflight and smoke checks.

It is **idempotent** — safe to re-run after a failure, and safe to re-run on an
existing deployment. It never overwrites an existing `.env` and never replaces
existing certificates.

```bash
./deploy.sh --self-signed --demo    # staging: self-signed cert + synthetic prices
./deploy.sh --help                  # all options
```

**Two things `deploy.sh` cannot do for you**, and neither is optional before real
users:

1. **Attach a MetaTrader 5 terminal** (section 6). The price feed is file-based
   and there is no HTTP market-data source anywhere in this codebase. Without a
   terminal there are no prices and nothing is tradeable.
2. **Enrol 2FA for every platform admin** (section 4). `deploy:preflight` fails
   until coverage is complete, which is why it may be red on a first deploy.

---

## 1. What "provisioned" means

The database is provisioned by **`npm run db:provision`**, which the compose
`migrate` service runs. It is the only database command a deployment should ever
run, and it is correct on both an empty and an existing database:

| Database | What it does |
|---|---|
| Empty | applies `migrations/000_core_schema.sql`, records the manifest's migrations as baselined, then migrates anything newer |
| Existing | migrates only |
| Either | asserts core tables exist and every money column is `NUMERIC`, not a binary float |

> **Do not run `npm run migrate` on a clean database.** It fails by design.
> `000_core_schema.sql` is the schema as it is *today*, and replaying 001..NNN on
> top of it re-applies finished steps to a finished schema — 005 indexes a column
> 008 drops, so it is absent from the dump and the index cannot be built.
> `migrations/000_core_schema.js` throws with that explanation rather than
> letting it fail confusingly several migrations later.
>
> This is not hypothetical: the compose `migrate` service and the Railway
> `startCommand` both ran `npm run migrate`, so a fresh volume left `migrate`
> exiting non-zero and, because `backend` waits on
> `service_completed_successfully`, **the entire stack never started.** CI passed
> throughout, because it open-coded baseline-then-migrate in the workflow instead
> of running the command production runs. Both now call `db:provision`.

Regenerate the schema of record after any migration that changes it:

```bash
npm run schema:dump      # writes 000_core_schema.sql + .manifest.json — commit both
```

## 2. Environment

`deploy.sh` generates every secret with `openssl rand -hex 32`. `backend/env.js`
rejects anything under 32 chars or matching
`/your-|changeme|change-me|example|placeholder|password|default/i`, so they
cannot be hand-written.

Hard-required in production (`REQUIRED_IN_PROD` in `backend/env.js` — startup
calls `process.exit(1)` without them): `DATABASE_URL`, `JWT_SECRET`,
`ADMIN_JWT_SECRET`, `ADMIN_PASSWORD`, `KYC_FILE_ENCRYPTION_KEY`.

Worth knowing regardless of who filled them in:

- [ ] `FRONTEND_URL` — **this drives the CORS allowlist.** There is no
      `CORS_ORIGINS` variable; `utils/allowedOrigins.js` reads `FRONTEND_URL`
      plus optional comma-separated `ALLOWED_ORIGINS`.
- [ ] `VITE_API_URL` — **must stay empty.** It is the frontend's axios baseURL
      and every request path already begins with `/api/...`, so behind the
      same-origin nginx proxy empty is correct. A value here produces
      `/api/api/...` and breaks every request.
- [ ] `TRUST_PROXY=1` behind the bundled nginx (one hop). Increase only if you
      add another proxy in front, e.g. Cloudflare.
- [ ] `ENGINE_MODE=event` is the default (see section 7).
- [ ] SMTP is **not** configured by `deploy.sh`. Until you set `SMTP_*`, password
      reset, KYC and payout emails do not send — silently.

### Frontend build-time variables

Anything the SPA reads via `import.meta.env.VITE_*` is inlined by Vite **at build
time**. It cannot be injected into a running container. Each one must be declared
as an `ARG` in `frontend/Dockerfile` and passed by `docker-compose.yml`; CI
asserts both directions. Changing one needs a rebuild:

```bash
docker compose up -d --build frontend
```

`VITE_FX_CONVERSION_ENABLED` is fed from the backend's own `FX_CONVERSION_ENABLED`
so the two cannot disagree — the frontend uses it to decide which instruments may
be opened, and the backend enforces the same set.

## 3. TLS

- [ ] `./deploy.sh --domain <host>` issues a Let's Encrypt certificate via
      certbot standalone **before** nginx claims port 80. `--self-signed`
      generates a staging certificate instead.
- [ ] Renewal is **not** automatic. `deploy.sh` prints the cron line; install it.
      Renewal must be followed by `docker compose restart nginx`.

## 4. Admin access

- [ ] `deploy.sh` creates one active platform admin and prints the password
      **once**. It is not stored anywhere you can read it back.
- [ ] Enrol TOTP 2FA for **every** platform admin. `deploy:preflight` is strict
      under `NODE_ENV=production` and fails while any active admin lacks it.
- [ ] Rotate `ADMIN_PASSWORD` after bootstrap; it must not be a day-to-day
      credential.
- [ ] Confirm `/api/admin/security/status` reports DB-backed admin migration
      complete and 2FA coverage complete.

## 5. Backups

- [ ] Install the backup cron: `0 2 * * * /opt/propfirm/scripts/backup.sh`
- [ ] **Test a restore** (`scripts/restore.sh`) before accepting real users. An
      untested backup is not a backup.

## 6. Price feed — read this before choosing your host

The feed is **file-based only**. `priceFeed.js` reads DWX text files, and
`price_feed_sources.source_type` accepts exactly `shared_env` and `dwx_path`.
**There is no HTTP or WebSocket market-data provider anywhere in the codebase.**

The backend container is `node:20-alpine` and contains no MetaTrader. So:

- [ ] A MetaTrader 5 terminal runs **outside** these containers — a Windows host
      or Wine — with the DWX expert advisor attached.
- [ ] It writes `DWX_Market_Data.txt`, `DWX_Commands_0.txt` and
      `DWX_History_Export.json` into the host directory named by
      `MT5_BRIDGE_PATH`.
- [ ] That directory is bind-mounted at `/app/mt5-bridge` **read-write** — the
      backend writes command files to subscribe to symbols — and must be owned by
      uid 1001. `deploy.sh` handles this.
- [ ] Ticks are flowing for every enabled symbol **before** enabling trading.
- [ ] Stale-feed alerts are visible to admins.

This is the single biggest constraint on deployment topology, and the reason a
pure managed-PaaS deploy (Render, Railway, Fly) is not viable without first
building an HTTP price-source adapter.

### The demo feed

`./deploy.sh --demo` starts `scripts/fake-dwx-feed.js` as a compose service,
writing synthetic prices into the same bridge directory. It exists so a first
deploy can be verified end to end before a terminal is attached.

- It refuses to run under `NODE_ENV=production` unless `ALLOW_DEMO_FEED=true`.
- **Stop it before attaching a real terminal** — both write the same file:
  `docker compose --profile demo stop dwx-demo`

## 7. Trade engine

`ENGINE_MODE=event` is the default. The price tick drives SL/TP, pending fills,
trailing drawdown, daily loss and profit targets directly (~50–80ms reaction,
versus 500–1500ms polling), with the loops demoted to safety fallbacks.

Both modes make identical decisions, verified by:

```bash
npm run engine:equivalence          # 11 scenarios, diffs every engine-written table
```

It reports **one accepted divergence**: `accounts.eod_peak_equity` is higher
under `event`, because that path evaluates every tick while `interval` samples
once a second and misses intermediate highs. The event figure is the truer
high-water mark, but it feeds the trailing drawdown floor — so a higher peak
means a higher floor and traders breach marginally earlier. That fairness trade
was taken deliberately on 2026-08-17. Any *other* divergence fails the harness.

Roll back with `ENGINE_MODE=interval` and a restart. No migration to revert.

## 8. Verification

```bash
cd backend
npm run lint                 # 0 errors
npm run check                # syntax, admin bindings, tracked requires,
                             #   and SQL parameter type collisions
npm test                     # 395 passing
npm audit --audit-level=high # clean

cd ../frontend
npm run lint                 # 0 errors
npm test                     # 77 passing
npm run build
npm audit --audit-level=high # clean

# Against the running stack
docker compose exec backend npm run deploy:preflight
docker compose exec backend npm run launch:smoke -- --provision
```

`launch:smoke --provision` registers a throwaway trader, has the admin issue it
an account, then opens and closes a real trade — so it verifies the money path on
a database that has never had a user in it. It waits out `min_hold_seconds`
(default 60), so allow it a couple of minutes. It leaves the test user behind;
the address is `smoke-test+...@example.com`.

## 9. Manual trading checks

`launch:smoke` covers registration, account issue, and one open/close. The rest
is manual, against the live stack:

- [ ] KYC upload → admin review
- [ ] challenge purchase (Stripe test mode)
- [ ] pending order create → trigger
- [ ] SL close, TP close, partial close
- [ ] drawdown breach → account fails
- [ ] profit target → account passes
- [ ] news-window block, and confirm close/reduce-risk actions stay allowed
- [ ] payout request → admin approve

## 10. Post-start

- [ ] `/api/health` returns `launch_ready: true`
- [ ] `docker compose ps` — all healthchecks green
- [ ] Socket.IO connects from the browser (live prices tick on the terminal)
- [ ] Backup cron installed and a restore tested

## Go / No-Go

Do **not** go live if any of the following is true:

- tests fail, or lint reports errors
- `npm audit --audit-level=high` is non-clean on either package
- `npm run deploy:preflight` does not pass
- admin 2FA coverage is incomplete
- a database restore has not been tested
- the price feed is stale, not flowing, or still the demo feed
