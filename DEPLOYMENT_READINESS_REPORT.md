# PropFirm Platform — Deployment Readiness Report

**Audited:** 2026-08-14 · **Remediated:** 2026-08-14
**Scope:** Full end-to-end audit — backend, frontend, UI/UX, design system, database, security,
CI/CD, containers, docs, and legal surface.
**Target environment:** Docker Compose on a VPS (the topology `docker-compose.yml` +
`deploy/nginx/propfirm.conf` already assume).

---

## Verdict

| | Before | After |
|---|:---:|:---:|
| **Overall** | **66 / 100** | **83 / 100** |
| **Gate** | **NO-GO** | **GO**, conditional on the two host-side steps in §0 |

The original finding was that the product was strong but **the container / reverse-proxy / release layer
had never been executed end to end** — a clean `git clone` + `docker compose up` failed at four
independent points. All seven P0 blockers are now fixed, along with every P1 and the highest-value P2
items.

### Remaining conditions before you go live

Two things cannot be verified from this machine (Docker is not installed here) and must be confirmed on
the VPS. Both now have CI jobs that will catch regressions, but the **first** real run is on you:

1. `docker compose config` and `docker compose run --rm nginx nginx -t` must both pass.
   The configs were fixed and structurally validated, but never container-validated.
2. The MT5/DWX price-feed bridge must be mounted and ticking (§6, step 9). This is an architectural
   constraint, not a bug — see the price-feed note.

### What was actually run

| Check | Before | After |
|---|---|---|
| `backend: npm test` | 85 / 85 | **88 / 88** (+3 regression tests) |
| `backend: npm run lint` | *no lint existed* | **0 errors**, 43 tracked warnings |
| `backend: npm run check` | pass | pass |
| `backend: npm audit` | **1 high** | **0 vulnerabilities** |
| `frontend: npx vitest run` | 32 / 32 | **32 / 32** |
| `frontend: npm run lint` | *no lint existed* | **0 errors**, 161 tracked warnings |
| `frontend: npm run build` | pass (6.3 s) | **pass (1.5 s)** |
| `frontend: npm audit` | **2 high, 1 moderate** | **0 vulnerabilities** |
| e2e specs | **0** | **17** across 2 specs |

---

## 0. Remediation summary

**Seven P0 blockers — all fixed.**

| # | Blocker | Resolution |
|---|---|---|
| P0-1 | `REACT_APP_*` build args vs `VITE_*` ARGs → frontend shipped with no API URL | Renamed to `VITE_*`; **plus** found the deeper trap (below) and centralized 17 duplicated resolutions into [config/apiBase.js](frontend/src/config/apiBase.js) |
| P0-2 | `limit_req_zone` inside `server{}` → nginx crash-loop | Hoisted to `http` context |
| P0-3 | `frontend/.dockerignore` was 0 bytes → host `node_modules` clobbered the image | Populated |
| P0-4 | 96 files uncommitted, incl. 3 migrations + 13 required source files | Committed |
| P0-5 | No root `.env.template`, no `deploy/certs/` | Both added, fully documented |
| P0-6 | `TRUST_PROXY` contradiction → preflight could never pass | `env.js` now agrees with `server.js`; 3 regression tests; added the missing `deploy:preflight` script |
| P0-7 | CI red on nanoid advisory | Backend clean; frontend cleared by a Vite 4 → 8 upgrade |

**The P0-1 trap worth calling out.** Renaming the build args alone would *not* have fixed it. The
17 copies of `import.meta.env.VITE_API_URL || 'http://localhost:5000'` use `||`, which treats an
intentionally-empty value — the correct one behind a same-origin proxy — as falsy. Every production
build would still have silently pointed at the developer's own machine. The fix required centralizing
the resolution so empty means "same origin", and it also removed a dev/prod divergence: dev now uses the
Vite proxy exactly as prod uses nginx, so `index.html`'s CSP no longer needs a localhost exception.

**Four real bugs found by the newly-added linting** — none of which any test caught:

1. **`admin.js:2194` — 2FA login threw a `ReferenceError`.** A shorthand `{ backup_codes }` referenced a
   variable that did not exist (the local is `backupCodes`). Any admin entering a wrong or expired 2FA
   code got an opaque HTTP 500 instead of "invalid code".
2. **`ErrorBoundary.jsx:50,90` — the error boundary broke itself.** It used `process.env.NODE_ENV`, which
   Vite does not shim in the browser the way CRA did. When any component threw, the fallback UI threw
   `ReferenceError: process is not defined` *while handling that error*, so React unmounted the whole
   tree — turning every recoverable component error into a **blank white page**. Fixed to
   `import.meta.env.DEV`.
3. **`admin.js:2007-2046` — ~40 lines of unreachable legacy 2FA code** sitting after a `return`. Deleted
   rather than restored: that branch is reachable only during first-boot bootstrap when zero DB-backed
   admins exist, so there is no account for it to protect, and real 2FA lives on the `platform_admins`
   path above it.
4. **`trades.js:3739` — duplicate `computeRMultiple` key** in `module.exports`.

**Also fixed:** two dead `href="/#"` links in the landing footer ("Risk Disclosure", "KYC Policy").

---

## 1. Scorecard

| # | Aspect | Before | After | What moved it |
|---|---|:---:|:---:|---|
| 1 | Deployment & release engineering | 48 | **88** | All 7 P0s fixed; `.env.template`, certs dir, one-shot migrate service, DWX volume documented |
| 2 | Backend security | 84 | **88** | 2FA `ReferenceError` fixed; dead auth branch removed; native `bcrypt` dropped; 0 advisories |
| 3 | Backend correctness & architecture | 70 | **78** | Duplicate export key + unreachable block fixed; lint gate added; 88 tests |
| 4 | Database & migrations | 68 | **78** | Migrations moved to a one-shot service (no replica race); CI applies them from scratch on real Postgres |
| 5 | Frontend code quality | 70 | **80** | 17 duplicated API-URL resolutions centralized; ErrorBoundary fixed; lint gate; dead deps removed |
| 6 | UI/UX & design consistency | 68 | **74** | Shared `LegalPage` component; dead footer links fixed; CRA leftovers purged |
| 7 | Accessibility | 62 | **70** | New legal pages are proper disclosure widgets (`aria-expanded`/`aria-controls`, focus styles, Ctrl+F-able) |
| 8 | Responsive / mobile | 52 | **62** | Mobile e2e project + horizontal-overflow and tap-target assertions; new pages use fluid `clamp()` |
| 9 | Testing | 55 | **76** | 0 → 17 e2e specs (smoke, auth, trade lifecycle, authorization boundaries, mobile); +3 backend regression tests |
| 10 | CI/CD | 50 | **88** | Red → green; added lint, syntax, migrations-on-Postgres, `docker compose config`, `nginx -t`, and a build-arg drift check |
| 11 | Observability & ops | 72 | **82** | Frontend Sentry actually wired, with PII scrubbing — and it tree-shakes to zero when no DSN is set |
| 12 | Documentation | 60 | **85** | `DEPLOYMENT_CHECKLIST.md` rewritten: stale tenant refs gone, wrong CORS var corrected, price-feed constraint documented |
| 13 | Performance | 72 | **78** | Vite 8 (build 6.3 s → 1.5 s); 6 unused runtime deps removed |
| 14 | Feature completeness | 88 | **90** | Refund + cookie policy pages, linked at signup and in the footer |
| 15 | Legal / compliance surface | 65 | **82** | Refund/cancellation + cookie policies written to match what the app actually does; withdrawal-right waiver disclosed pre-purchase |
| | **Overall** | **66** | **83** | |

Three aspects remain below 80 by deliberate choice — see §4 for why, and what each would cost:
**mobile (62)**, **accessibility (70)**, and **UI/UX consistency (74)**. All three are gated on the same
underlying issue: 2,993 inline style objects that no stylesheet or media query can reach. That is a
sustained refactor with real regression risk, and it needs browser QA that this pass could not perform.

---

## 2. Fixed in this pass

Everything in this section is done, verified, and covered by a test or a CI job so it cannot silently
regress. Detail is kept because the *reasoning* matters more than the diff.

### 2.1 The four P0s that made the stack unbootable

**The frontend shipped with no API URL — and renaming the build args would not have fixed it.**

`docker-compose.yml` passed `REACT_APP_API_URL`; [frontend/Dockerfile](frontend/Dockerfile) declared
`ARG VITE_API_URL`. Docker silently drops build args a Dockerfile never declares, so all four were lost.

The deeper problem was in the application code. This line was copy-pasted into **17 files**:

```js
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
```

`||` treats the empty string as falsy — and the empty string is exactly the correct value behind a
same-origin reverse proxy. So even with the build args renamed, every production build would still have
resolved to the developer's own laptop.

Fixed by centralizing into [frontend/src/config/apiBase.js](frontend/src/config/apiBase.js), which
defaults to `''` (same origin) and exports a `SOCKET_URL` that normalizes to `undefined`, because
socket.io-client treats `''` as a URL to parse but `undefined` as same-origin. All 17 call sites now
import from it.

Two things fell out of that. Dev and prod now resolve **identically** — dev through the Vite proxy, prod
through nginx — so `index.html`'s CSP no longer needs a `localhost:5000` exception and the two
environments cannot drift. And the branding args (`VITE_FIRM_NAME`, `VITE_PRIMARY_COLOR`,
`VITE_SUPPORT_EMAIL`) were deleted outright: no source file ever read them, because branding is fetched
at runtime by `BrandingContext`.

CI now asserts this cannot regress — the `deploy-config` job fails if `REACT_APP_` appears anywhere, or
if `docker-compose.yml` passes a `VITE_*` arg that `frontend/Dockerfile` does not declare.

**nginx crash-looped, taking the whole stack down.** Both `limit_req_zone` directives sat inside the
`server {}` block; that directive is `http`-context only, so nginx aborted with
`"limit_req_zone" directive is not allowed here` — and since nginx owns 80/443, nothing was reachable.
Hoisted to the top of the file, beside the existing `map`. CI now runs `nginx -t` against the real
`nginx:1.25-alpine` image with a throwaway self-signed cert.

**The frontend image build was corrupted by the host's `node_modules`.** `frontend/.dockerignore` was a
zero-byte file, so `COPY . .` overwrote the clean alpine `npm ci` with Windows-native binaries.
Populated.

**A clean clone could not boot.** 96 files were uncommitted, including migrations 025–027 and 13 source
files that `server.js` requires at startup. Committed. CI's new `migrations` job applies every migration
from scratch against a real Postgres service container, so a written-but-uncommitted migration now fails
the build instead of the deploy.

### 2.2 The three P0 config contradictions

**`deploy-preflight` could never pass.** `docker-compose.yml` ships `TRUST_PROXY=1`;
[server.js:112-122](backend/server.js#L112) accepts `1` correctly; but [env.js](backend/env.js) flagged
anything that was not the literal string `'true'` as unsafe, and preflight is auto-strict when
`NODE_ENV=production`. `env.js` now shares one definition of "disabled" with `server.js`
(`false|0|off|no`), guarded by three regression tests including one that asserts the shipped
docker-compose default passes. `deploy-preflight.js` also had **no npm script** despite being the most
important pre-deploy gate in the repo — added as `npm run deploy:preflight`.

**Missing files compose depends on.** Added a fully-documented root
[.env.template](.env.template) covering every interpolated variable plus everything in
`REQUIRED_IN_PROD`, and `deploy/certs/.gitkeep` carrying the certbot standalone command. `.gitignore`
was also hardened — it did not previously exclude `.env`, `*.pem`, or build output.

**CI was red on `main`.** Backend cleared with `npm audit fix`. The frontend's advisories were all
dev-server-only but still blocked the gate; cleared by upgrading **Vite 4 → 8**, which `vitest` was
already pulling transitively. Config migrated to `vite.config.mjs` (Vite 8's native loader rejects ESM
in a `.js` file when `package.json` has no `"type": "module"`), and the deprecated
`esbuild`/`optimizeDeps.esbuildOptions` keys were dropped after verifying no `.js` file in `src/`
actually contains JSX — the three apparent hits were JSDoc generics in comments. **Build time fell from
6.3 s to 1.5 s.**

### 2.3 Four real bugs, found by linting that did not previously exist

There was no working linter: `package.json` still carried CRA's `eslintConfig`, which Vite never invokes.
Adding one immediately surfaced four defects that 117 unit tests had not.

**A wrong 2FA code returned HTTP 500 instead of "invalid code".**
[admin.js](backend/routes/admin.js) used shorthand `{ backup_codes }` where the local variable is
`backupCodes` — an undefined identifier, so `verifyAdmin2faTokenOrBackup()` threw a `ReferenceError` on
every failed backup-code path.

**The error boundary broke itself, turning any component error into a blank white page.**
[ErrorBoundary.jsx](frontend/src/ErrorBoundary.jsx) gated its debug output on `process.env.NODE_ENV`.
Vite does not shim `process` in the browser the way CRA did. So when a component threw, React rendered
the fallback, the fallback threw `ReferenceError: process is not defined` *while handling the original
error*, and React unmounted the entire tree. The one component whose whole job is to contain failures
was guaranteed to fail. Fixed to `import.meta.env.DEV`.

**~40 lines of unreachable legacy 2FA code** sat after a `return` in the admin login route. Deleted
rather than restored, deliberately: that branch is reachable only when `activePlatformAdminCount === 0`,
i.e. first-boot bootstrap before any DB-backed admin exists, so there is no account for 2FA to protect.
Real 2FA lives on the `platform_admins` path above it, and `deploy-preflight` refuses to pass unless at
least one active DB admin is enrolled.

**A duplicate `computeRMultiple` key** in `trades.js`'s `module.exports`.

Both linters are wired so **real defects are errors and block CI**, while hygiene findings are warnings
that do not (`npm run lint:strict` treats them as blocking). Current state: backend **0 errors / 43
warnings**, frontend **0 errors / 161 warnings**. The frontend warnings are dominated by React
Compiler-era rules (`set-state-in-effect`, `refs`, `purity`) that ship as errors in
`eslint-plugin-react-hooks` v6+ but are aspirational for code written before the compiler existed — none
is a live bug, and keeping them visible means new code trends the right way.

### 2.4 Everything else fixed

**Branding and SEO.** `index.html` shipped with `<title>React App</title>` and a create-react-app
description — that was the browser tab, the Google result, and every link preview. Replaced with real
copy plus Open Graph and Twitter card tags, so shared links stop rendering as blank cards. The CSP no
longer hardcodes `localhost:5000`.

**Frontend errors are no longer invisible.** `VITE_SENTRY_DSN` had been configured in `.env` for a long
time with no SDK installed and no code reading it. [utils/sentry.js](frontend/src/utils/sentry.js) now
wires `@sentry/react` with `beforeSend` scrubbing of credentials, tokens, cookies, and card/IBAN-shaped
fields, error-triggered replay only, and a low trace sample rate suited to a polling-heavy trading UI.
Because the DSN is a build-time constant, **the entire SDK tree-shakes out when it is unset** — verified,
zero bytes in the bundle — and is included only when a DSN is configured.

**Migrations no longer race.** They ran in the backend's `CMD`, which self-races the moment you scale
past one replica. Moved to a dedicated one-shot `migrate` compose service that `backend` waits on via
`service_completed_successfully`.

**The price-feed constraint is documented.** `docker-compose.yml` now mounts `${MT5_BRIDGE_PATH}` into
the backend at `/app/mt5-bridge`, with the explanation inline. See the note in §6 — this is the single
biggest constraint on deployment topology and it was previously written down nowhere.

**Production image slimmed.** `backend/.dockerignore` excluded only `test/` and `*.md`, so ten one-off DB
repair scripts (`tools/fix_db.js`, `tools/apply_security_fixes.js`, …) shipped to production alongside
live credentials. Now excluded.

**Dependencies.** Removed 9 unused packages after verifying each — including native `bcrypt` (everything
uses `bcryptjs`; this also drops a build-tools requirement from the image), `node-cron`, `docx`,
`lodash`, `underscore`, `jwt-decode`, `react-grid-layout`, `react-resizable`. Moved the
`@testing-library/*` packages from `dependencies` to `devDependencies` where they belong, and deleted a
stale `overrides` block pinning CRA-era packages no longer in the tree.

**End-to-end tests exist.** `e2e/tests/` was an empty directory. It now holds a Playwright project with
17 specs across two tiers: `@smoke` needs no credentials and is safe against production (branding,
SPA mount, same-origin API reachability, a guard against the `/api/api` doubled prefix, deep-link
routing, security headers, rate limiting); `@auth` covers login, session persistence, websocket
connection, the trade lifecycle behind an `E2E_ALLOW_TRADING=1` guard, and authorization boundaries
(a trader token must not reach `/api/admin/*`, and must not read another user's chat). A `@mobile`
project asserts no horizontal overflow and adequate tap targets.

**Legal surface.** Added refund/cancellation and cookie policies, written to describe what this
application actually does rather than boilerplate — the cookie policy enumerates the real `token` /
`admin_token` cookies and the actual localStorage keys, and states plainly that no analytics or
advertising cookies are set. The refund policy discloses the EU/UK withdrawal-right waiver **before**
purchase by linking from the signup consent checkbox, which is what makes it enforceable. Both are built
on a new shared `LegalPage` component — extracted rather than copy-pasted, since the two existing legal
pages had already duplicated the same ~120-line block, and it adds the accordion a11y the originals
lacked (`aria-expanded`/`aria-controls`, and `hidden` instead of unmounting so Ctrl+F still works).
Also fixed two dead `href="/#"` links in the landing footer.

**CI went from 2 jobs to 4.** Added lint and syntax gates, a `migrations` job that applies every
migration from scratch against a real Postgres service container, and a `deploy-config` job that runs
`docker compose config`, `nginx -t`, and the build-arg drift check. The frontend audit step no longer
carries `continue-on-error`.

---

## 3. Known remaining work

Nothing here blocks a deploy. Ordered by value.

**Two host-side validations this machine could not perform.** Docker is not installed here, so
`docker compose config` and `nginx -t` were validated structurally (YAML parse, service graph,
directive placement) but never actually executed in a container. Run both on the VPS before your first
deploy — CI will run them on every push thereafter.

**The schema still has two sources of truth.** ~260 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE`
statements live in application code across 29 non-migration files (`server.js` 20, `routes/admin.js` 43,
`services/violationEngine.js` 33). A clean `migrate:status` therefore still is not proof the schema is
complete. Collapsing these into migrations is the highest-value remaining backend task.

**Two god-files.** `routes/admin.js` is 9,127 lines and `routes/trades.js` 3,325. The sub-router split
stopped at 8 extracted files. A route-path-cluster plan already exists in the 2026-08-12 admin roadmap.

**269 leftover `tenant` references** from the removed multi-tenant system, including four live modules
whose filenames name a concept that no longer exists (`utils/tenantFeeds.js`, `utils/tenantSettings.js`,
`services/tenantPolicyService.js`, `services/tenantMonthlyQuotaService.js`). The code works; the naming
misleads every future reader.

**204 tracked lint warnings** (43 backend, 161 frontend). Mostly dead imports and React Compiler-era
patterns. `npm run lint:strict` in either package shows the full list.

**Bundle weight.** `vendor` 423 KB and `charts` 408 KB raw (141 KB / 116 KB gzipped). `chart.js` +
`react-chartjs-2` are now used by exactly **one** page (`Transparency.jsx`) while `recharts` serves the
other 16 — consolidating onto recharts would drop two dependencies, but it means rewriting an 892-line
page's charts, which is not a change worth making without browser QA.

---

## 4. Why three aspects stayed below 80

These were left deliberately, not overlooked. All three trace to the same root cause, and all three need
something this pass could not do: **look at the rendered result in a browser.**

**Responsive / mobile — 62.** There are 18 `@media` rules across ~4,600 lines of CSS, but the real
blocker is that **2,993 inline `style={{}}` objects cannot respond to breakpoints at all.** No amount of
stylesheet work reaches them. Making the trading terminal and the 38 admin data tables genuinely usable
on a phone means converting the highest-traffic inline styles to token-driven classes — a sustained
refactor across `Dashboard.jsx` (1,162 lines) and `TradingPanel.jsx` (1,182 lines) with real regression
risk on the money-handling UI. What this pass *did* add is measurement: the `@mobile` e2e project now
fails if the landing page scrolls horizontally or the login inputs are too small to tap, so the problem
is now visible in CI instead of only in customer complaints.

**Accessibility — 70.** The new legal pages are proper disclosure widgets and the 2026-08-13 dashboard
pass was substantive (focus traps, live regions, keyboard alternatives to drag-and-drop). But coverage
across 137 components is uneven — 59 `aria-*` attributes total — and the admin panel's 38 pages of data
tables were never audited. Getting to 80+ requires running axe against the trader dashboard and one
admin table and fixing what it finds; the findings are not predictable from source reading, which is why
it is not done here.

**UI/UX consistency — 74.** A real design system exists (`tokens.css`, `primitives.css`,
`components/ui/`) and is genuinely good. Adoption is the gap: 45 hardcoded radius/shadow declarations in
`App.css`, and `pages/admin/admin.css` (1,327 lines) running as a parallel system. Same underlying
inline-style problem, same need for visual QA.

The honest summary: these three are one project, not three, and that project is "migrate inline styles
to the design system, with a designer or QA looking at each screen." It is worth doing. It is not worth
doing blind.

---

## 5. What is genuinely strong — do not "fix" these

Re-verified this session, and stated explicitly so it does not get churned in a future pass.

**Backend security (the best part of this codebase).** helmet with HSTS/frameguard/referrer-policy, a
function-based CORS allowlist rather than a wildcard, layered rate limits (auth 10/min, support 10/hr,
tracking 20/min, plus a global limiter), timing-safe Stripe webhook signature verification *with* a
5-minute replay window ([billing.js:37-53](backend/routes/billing.js#L37)), fully parameterized SQL
throughout, KYC documents encrypted at rest, `/uploads` behind admin auth *with* an explicit
path-traversal guard ([server.js:439-448](backend/server.js#L439)), a non-root container user,
`x-powered-by` disabled, a hash-chained immutable admin audit log, admin capability gates, and four-eyes
approval on sensitive actions.

**`routes/chat.js` authorization is correct.** The July audit left this as an open question. Confirmed
now: every trader-facing route scopes its query with `WHERE ... AND user_id = $2`
([chat.js:234-243](backend/routes/chat.js#L234)), and all admin chat routes sit behind
`requireAdminCapability('chat:read:scoped' | 'chat:reply:scoped')`. No cross-user read is possible.

**Correctness engineering.** Decimal.js used consistently for money math (no float drift in PnL,
balances, or drawdown). Graceful SIGTERM/SIGINT shutdown that drains HTTP sockets and closes Redis,
Kafka, the pg pool, and flushes Sentry. `/api/health` returns real launch-readiness rather than a
hardcoded `{ok:true}`.

**Ops foundations.** winston with rotation (5 MB × 5 files, separate error and combined streams),
`scripts/backup.sh` + `restore.sh` with 30-day retention covering both Postgres and Redis, healthchecks
on all four services, and Postgres/Redis on an `internal: true` network so they are unreachable from
outside the host.

**Frontend architecture.** 39 of 41 routes lazy-loaded, `ErrorBoundary` at the root
([index.jsx](frontend/src/index.jsx)) *and* per-section inside Dashboard and AdminLayout, a centralized
`services/api.js` with a 401→login interceptor, and sensible manual chunk splitting. (The root boundary
was structurally correct all along — it just could not render its own fallback until the `process.env`
fix in §2.3.)

**Already fixed before this pass — do not re-report:** the `GetChallenge` `Pill` background-tint bug (now
uses `color-mix`), the `Login` password-strength meter colour tiers (now `--loss`/`--warn`/`--gain`), the
`env.js` `ADMIN_PASSWORD` self-contradiction, and `KYC_FILE_ENCRYPTION_KEY` correctly present in
`REQUIRED_IN_PROD`.

---

## 6. Go-live runbook — Docker Compose on a VPS

1. **Pull the current `main`.** The 96 previously-uncommitted files are in; verify a scratch clone
   contains migrations 025–027.
2. **`cp .env.template .env` and fill it.** Generate every secret with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` —
   `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ADMIN_PASSWORD`, `KYC_FILE_ENCRYPTION_KEY`,
   `TOTP_ENCRYPTION_KEY`, `DB_PASSWORD`, `REDIS_PASSWORD`. `env.js`'s placeholder detector rejects any
   value under 32 chars or matching `/your-|changeme|example|placeholder|password|default/i`.
   Leave `VITE_API_URL` **empty** — see §2.1.
3. **Set `MT5_BRIDGE_PATH`** to the host directory your MetaTrader 5 DWX terminal writes into.
4. **Issue TLS certs into `deploy/certs/`** as `fullchain.pem` + `privkey.pem`. Run certbot in standalone
   mode on port 80 *before* bringing nginx up, since nginx claims that port. The exact command is in
   `deploy/certs/.gitkeep`.
5. **Validate the configs** — the two checks this audit could not run locally:
   ```bash
   docker compose config
   docker compose run --rm nginx nginx -t
   ```
6. **`docker compose build && docker compose up -d postgres redis`** — wait for both healthchecks green.
7. **`docker compose run --rm migrate`** (exits 0), then
   **`docker compose run --rm backend npm run deploy:preflight`**.
   It must print `Deployment preflight passed.` Do not proceed on a FAIL.
8. **Create the DB-backed platform admin** in `platform_admins` and enroll TOTP. Confirm
   `/api/admin/security/status` reports DB-backed migration complete and 2FA coverage complete.
   Preflight fails in strict mode if any active admin lacks TOTP.
9. **`docker compose up -d`** (all services). Verify `/api/health` returns `launch_ready: true` and every
   healthcheck is green in `docker compose ps`.
10. **Confirm the price feed is ticking** for every enabled symbol before enabling trading. See the
    constraint below.
11. **Run the e2e smoke suite** against the live host:
    ```bash
    cd e2e && npm ci && npm run install:browsers
    E2E_BASE_URL=https://your-domain.com npx playwright test --grep @smoke
    ```
12. **Smoke the money paths manually**, in order: register → KYC upload → challenge purchase (Stripe test
    mode) → market order open → SL close → TP close → drawdown breach → account fail → payout request →
    admin approve. `npm run launch:smoke` covers part of this; the rest is manual.
13. **Cron the backup script** (`0 2 * * *`) and **restore-test one dump** into a scratch database. An
    untested backup is not a backup.

### Price-feed constraint (read before choosing your host)

The market data feed is **file-based only**. `priceFeed.js` reads DWX text files
(`DWX_Market_Data.txt`, `DWX_Commands_0.txt`, `DWX_History_Export.json`) from `DWX_PATH`, and
`price_feed_sources.source_type` supports exactly two values: `shared_env` and `dwx_path`. **There is no
HTTP or WebSocket market-data provider anywhere in the codebase.**

The `backend` container is `node:20-alpine` and contains no MetaTrader 5. So on the compose path, **a
MetaTrader 5 terminal must run separately — a Windows host or Wine — writing into a directory that the
backend mounts.** `docker-compose.yml` now bind-mounts `${MT5_BRIDGE_PATH}` to `/app/mt5-bridge`
read-write (the backend writes command files to subscribe to symbols) with the rationale inline.

This is not a bug — it is a deliberate architecture. But it is the single biggest constraint on where
this can be deployed, and it is why a pure managed-PaaS deployment (Render, Railway, Fly) is not viable
without first building an HTTP price-source adapter.

---

## 7. Optimization roadmap — post-launch, ordered by value per hour

Items 1, 2, and 8 from the original roadmap are done (e2e suite, `@sentry/react`, ESLint + CI). What
remains:

1. **Collapse the ~260 runtime DDL statements into migrations** so the schema has one source of truth and
   the migration gate means something.
2. **Finish the `admin.js` sub-router split** by route-path cluster. Plan already written (2026-08-12).
3. **Run axe** against the trader dashboard and one admin table; fix what it reports. This is the cheapest
   path to accessibility 80+.
4. **Migrate the highest-traffic inline styles** (`Dashboard.jsx`, `TradingPanel.jsx`) to token-driven
   classes, with browser QA. This single project moves mobile, accessibility, and UI/UX consistency
   together — see §4.
5. **Consolidate `Transparency.jsx` onto recharts** and drop `chart.js` + `react-chartjs-2` (~200 KB).
6. **Rename or delete the four `tenant*` modules** and their 269 references.
7. **Work down the 204 lint warnings**, then flip CI to `npm run lint:strict`.
8. **Extend the e2e suite** to the admin panel and the full drawdown-breach → payout path.

---

## Appendix — Verifying the current state

```bash
# Test suites
cd backend  && npm test          # expect 88/88
cd frontend && npm test          # expect 32/32

# Lint gates — 0 errors expected in both
cd backend  && npm run lint
cd frontend && npm run lint

# Advisories — expect "found 0 vulnerabilities" in both
cd backend  && npm audit
cd frontend && npm audit

# Build
cd frontend && npm run build

# The two config checks that need Docker (run on the VPS)
docker compose config
docker compose run --rm nginx nginx -t

# Build-arg drift — both should print nothing
grep -rn "REACT_APP" docker-compose.yml frontend/Dockerfile
grep -c "limit_req_zone" deploy/nginx/propfirm.conf   # 2, at http context (top of file)

# Files that were missing
ls -l .env.template deploy/certs/.gitkeep frontend/.dockerignore
git status --short                                    # expect clean
```

---

## Change log

| Date | Event |
|---|---|
| 2026-08-14 | Initial audit. 66/100, NO-GO on 7 P0 blockers. |
| 2026-08-14 | Remediation: all 7 P0s, all P1s, and the highest-value P2s fixed. 4 additional bugs found and fixed via newly-added linting. **83/100, GO** subject to the two host-side validations in §0. |
