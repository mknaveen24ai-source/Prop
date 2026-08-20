# PropFirm Production Audit — 2026-08-19

Branch `audit/production-2026-08-19`, 8 commits off `7cd17a5`, 20 files,
+3,031 / −14.

---

## Executive summary

**PRODUCTION READY WITH CONDITIONS.**

Six defects were found and fixed. Five of them broke a live endpoint on every
single request, and none was visible to the test suite, to lint, or to three
previous audits of the same code.

That is the finding behind the findings. **17 of 43 backend test files mock the
pg pool**, so a green suite says almost nothing about whether the SQL is
correct. Every defect below was found by executing the application against real
PostgreSQL — a running server, a provisioned database, and concurrent requests.
The static signals were, and remain, clean: 0 lint errors, 0 npm
vulnerabilities, 0 hardcoded secrets.

The conditions on readiness are operational, not code: admin 2FA enrolment, and
pushing the branch. Both are listed at the end.

| | Before | After |
|---|---|---|
| Backend tests | 432 pass | **445 pass**, 0 fail |
| Frontend tests | 77 pass | 77 pass |
| Endpoints answering 500 unconditionally | **4** | 0 |
| Authorization assertions run | 0 | **2,352**, 0 violations |
| SQL statements type-checked against Postgres | 0 | **460** |
| Money path FX conversion | off — 31/45 instruments wrong | **on, verified on a real trade** |
| Deploy hardening gate | existed, never invoked | invoked and reported |

---

## Scores

Weighted toward security and financial integrity, as a platform holding trader
money should be.

| Area | Score | Basis |
|---|---:|---|
| Security | 88 | 2,352 authorization assertions clean; JWT forgery, injection, traversal all rejected; abuse detector and limiters observed working |
| Authentication | 90 | No user enumeration, neutral reset messaging, HttpOnly + SameSite=Strict, `secure` correctly gated on production |
| Authorization | 92 | Every endpoint × every principal exercised; all five admin roles verified live |
| Financial integrity | 85 | FX cutover proven on a real trade; all money columns NUMERIC; rounding does not compound |
| Trading engine | 84 | Float-detects/Decimal-confirms parity now asserted across five FX rates, not just rate 1 |
| Risk engine | 82 | Exposure cap held exactly at 1.0000 lots under 8 simultaneous opens |
| Challenge engine | 80 | Unchanged this pass; covered by existing suite |
| Payment | 72 | Stripe checkout was 500ing for every caller (fixed); webhook path uses raw body before json parsing, correct |
| Payout | 78 | Eligibility re-checked at approval; outcome correct under concurrency, but the row lock itself is unproven — see U-1 |
| Business logic | 82 | Partial closes were impossible platform-wide (fixed) |
| Database | 86 | Schema of record verifies; two type mismatches found and one migrated |
| API | 84 | 300 endpoints inventoried, classified and driven |
| Frontend | 78 | Builds clean; 160 lint warnings, 100 of them `set-state-in-effect` (untouched, see L-1) |
| Admin | 85 | Scoped roles alive and correctly bounded |
| Testing | 74 | 445 tests, but the pg-pool mocking that hid every defect here is still the dominant pattern |
| Error handling | 84 | Dark-rate failures now retryable 503s rather than generic 500s |
| Performance | 80 | Not re-measured this pass |
| Dependency security | 95 | 0 vulnerabilities, prod and dev |
| Configuration | 82 | Security headers complete; strict env checks now surfaced |
| Deployment | 80 | One-command deploy works; hardening gap now reported rather than hidden |
| CI/CD | 86 | Two new schema guards wired into the migrations job |
| Observability | 83 | Request IDs, Prometheus, slow-query logging in place |
| Documentation | 80 | This report; harnesses documented at length in-file |

### **OVERALL: 83 / 100**

Held below 90 by one thing: the testing practice that produced these bugs is
unchanged. The guards added here catch this *class*, but the next class will
hide in the same place.

---

## Critical

### C-1 — Stripe challenge checkout returned 500 for every caller · FIXED

`POST /api/billing/challenge/checkout-session`

```sql
WHERE id = $1 AND ($2::bigint IS NULL OR user_id = $2)
```

`challenge_orders.user_id` is `TEXT`. The cast pinned `$2` to bigint for the
whole statement, so the ownership comparison became `text = bigint` and Postgres
refused to plan it. The route sits behind `authenticateToken`, so `userId` is
never null and the broken branch always ran.

**Impact:** nobody could pay for a challenge through Stripe. On a platform whose
revenue is challenge sales, this is the money door being welded shut.

**Fix:** cast the *parameter*, not the column, preserving any index on
`user_id` — the same rule applied to the earlier uuid/text collision in
`routes/trades/open.js`.

**Verification:** the original `PREPARE` fails with
`operator does not exist: text = bigint`; the fixed statement executes with a
real uuid and with NULL.

---

## High

### H-1 — Every partial close returned 500 · FIXED

`trades.id` is `uuid`. `trades.parent_trade_id` was `integer`.
`routes/trades/close.js` writes the parent's id into that column, so Postgres
rejected the insert and rolled back the entire close:

```
invalid input syntax for type integer: "b9aa1b25-6266-42c3-8f97-24e400fdbf87"
```

**Impact:** no trader could scale out of a winner or cut half a loser. The only
exit from a position was to close all of it. On a product with drawdown limits,
someone trying to reduce exposure kept all of it instead.

Almost certainly a survivor of the integer→uuid trade id migration: `trades.id`
was converted, this self-reference was not.

**Fix:** migration `038_fix_parent_trade_id_type.js`. No data can be lost — every
write to the column failed, so it is NULL on every row (confirmed zero non-null
on both a production-shaped and a freshly provisioned database). The migration
re-checks at run time and refuses rather than discarding anything unexpected, in
both directions.

**Verification, through the real HTTP path:**

```
open 1.00 lots EURUSD, close_lots 0.4
parent  3a3dc9f5   0.6000 lots  open
child   8238a841   0.4000 lots  closed   parent_trade_id -> 3a3dc9f5
balance 10000.00 -> 9998.40
```

A freshly provisioned database now lands on `uuid` too, so new and upgraded
databases agree.

### H-2 — Public trader profile returned 500 for every id ever requested · FIXED

`GET /api/auth/profile/:userId`, unauthenticated. Two defects in one handler:

1. `SELECT id, full_name, country, created_at ... FROM users u LEFT JOIN accounts a`
   — every one of those columns is ambiguous across the join.
   `column reference "id" is ambiguous`.
2. Both queries passed `parseInt(userId)` for a uuid column. A comment above the
   handler records fixing the numeric guard for uuids; the `parseInt` calls it
   was guarding were left behind.

**Fix:** qualify the columns, pass the uuid. Returns 200 with real data.

### H-3 — Admin cohort analytics returned 500 unconditionally · FIXED

`GET /api/admin/cohort-analytics` summed `p.amount`; the payouts table has
`amount_requested` and `amount_payable` and never had `amount`.

**Fix:** `SUM(p.amount_payable) FILTER (WHERE p.status = 'paid')`, matching the
convention every other paid-out total already uses.

---

## Medium

### M-1 — A dark currency rate 500'd traders mid-position · FIXED

Exposed by the FX cutover. Under conversion, `calculatePnL` throws when the
instrument's QUOTE/USD rate is missing from the price cache. Every cross-JPY
pair takes its rate from USDJPY, so **one dark symbol makes six other
instruments unvaluable** while their own prices keep arriving.

`services/tradeEngine.js` already handled this deliberately. Neither HTTP path
did, and they need opposite treatment:

- **`open.js`** summed floating PnL unguarded, so opening *any* trade 500'd for
  any account holding a JPY position. It now refuses with 503 after rolling
  back. It must refuse rather than skip: the engine can skip safely because
  understating floating loss means declining to declare a breach, but this sum
  is the equity behind a **margin check**, where understating loss *overstates*
  equity and admits a trade that should have been refused. Skipping fails open.
- **`close.js`** returned a generic 500. The trader still holds the position and
  is still exposed, so it now returns a retryable 503 stating the position is
  unchanged.

No fallback to a stale rate on either path — booking a realised PnL at a rate
nobody can vouch for writes a wrong number into the ledger permanently.
`test/fxRateUnavailable.test.js` asserts no such fallback exists, so adding one
must be a deliberate conversation.

### M-2 — The strict deploy gate existed and was never invoked · FIXED

`deploy:preflight` treats admin 2FA coverage and unsafe production env vars as
blockers **only** under `DEPLOY_CHECK_STRICT=1`. Nothing set it — not deploy.sh,
not CI, not package.json, nowhere in the repository. So the permissive run was
the only one ever executed, and it reports:

```
PASS  Platform admin 2FA coverage: 0/29
```

A real deployment finished on "Deployment preflight passed" with not one admin
holding a second factor.

**Fix:** `deploy.sh` now runs the strict pass too and prints its FAIL lines under
"production hardening is incomplete". It deliberately does not *block* — on a
first install the admin was created minutes earlier and cannot have enrolled 2FA
yet — but the operator now finishes knowing what remains. The closing banner
distinguishes "Stack is up and hardened" from "Stack is up — hardening
incomplete".

### M-3 — Engine parity was only ever asserted at FX rate 1 · FIXED

The engine's safety argument is "float detects, Decimal confirms", and
`test/fastPnL.test.js` asserts the two agree — but resolved no rate, so it only
compared them at rate 1. `utils/fastPnL.js` warns about exactly this: *"a
confirm step only catches what the two implementations disagree about"*, which
is how the original FX bug stayed invisible when both shared the same wrong
assumption.

Parity was therefore unasserted on the converted path — now the production path
for 31 of 45 instruments. Both sides now take an explicit rate, asserted across
five including JPY, plus two **absolute** assertions, because agreeing with each
other while both being wrong is what parity alone cannot see.

---

## Unresolved

### U-1 — The payout row lock is unproven · UNVERIFIED

Eight concurrent payout requests on an eligible funded account produce the
correct outcome — `{"201":1,"429":7}`, exactly one payout row. But **seven were
stopped by the 24-hour rate limiter before the database row lock was
contended.**

That limiter is Redis-backed and falls back to in-process counters when Redis is
unavailable (`utils/security.js` `makeSharedStore`), and in-process counters do
not span instances. On a multi-instance deploy with Redis down, concurrent
requests can land on different instances, each pass their own limiter, and leave
the row lock as the only thing between a trader and a double payout.

The lock may well be correct — `domain/payout.js` holds `FOR UPDATE OF p` — but
this audit did not prove it, and it is reported as unproven rather than credited
for the limiter's work. **Recommended:** a direct two-connection test against
the domain function, bypassing HTTP.

### L-1 — 100 `react-hooks/set-state-in-effect` warnings · OPEN

Unchanged from previous audits. Mechanical but wide; deliberately not bundled
with correctness fixes.

### BLOCKED — needs you

- **Revoke the GitHub PAT.** It was embedded in the `origin` remote URL in
  `.git/config` and printed by any `git remote -v`, including CI logs and screen
  shares. **I stripped it from the local config; only you can revoke the token
  itself.**
- **Admin 2FA enrolment.** Needs your authenticator. Until then strict preflight
  fails, by design.
- **`main` is 105 commits ahead of an unpushed `origin`.** A `git clone` still
  gets ancient, broken code.
- **Docker is not installed here**, so compose/nginx validation remains CI-only.

---

## What was built

Four executable harnesses, because the defects here were invisible to reading.

| Tool | What it does | Found |
|---|---|---|
| `scripts/check-sql-columns.js` | Diffs every attributable `table.column` write against `information_schema` | H-3 |
| `scripts/audit/sql-prepare-check.js` | `PREPARE`s 460 static statements so Postgres parses, resolves and plans them | C-1, H-2 |
| `scripts/audit/authz-matrix.js` | 294 endpoints × 8 principals = 2,352 assertions | 0 violations |
| `scripts/audit/race-conditions.js` | 8 simultaneous requests per money path, asserting on database state | U-1 |
| `scripts/audit/money-integrity.js` | Conversion across 31 non-USD instruments, float columns, rounding drift | — |
| `scripts/audit/route-inventory.js` | Reconstructs the HTTP surface from mounts + live middleware stacks | — |

Wired into CI's migrations job (`check:sql-columns`, `check:sql-prepare`), where
the schema is built by the real migrations.

### The harnesses had to be made incapable of lying

This is where most of the work went, and it is the part worth keeping.

The **authorization matrix** produced three separate false passes before it was
trustworthy. It banned its own trader, disabled its own super admin by resolving
`/admin-users/:id` to `1`, and got IP-blocked four seconds in. Each one would
have reported "0 violations". It now targets a disposable trader and a
sacrificial admin, checks principal liveness before and after so a session that
dies mid-sweep invalidates its own results instead of scoring later 401s as
"correctly denied", and paces at 8/s under the abuse detector rather than having
a working production control switched off for it.

The **race harness** reported four clean passes on its first run and three were
worthless — all-404s because the probe had already closed the position, all-400s
because the request was oversized even singly, all-429s because a limiter ate
them. It now distinguishes *was the contended resource reached at all* from
*which defence turned the others away*, prints the rejection reasons, and exits
non-zero on an unverified check: **"nothing was proven" must not read as
"everything is fine."**

---

## FX cutover

`FX_CONVERSION_ENABLED=true`, after `fx:cutover-check` reported READY — no open
position on a non-USD instrument, nine rate sources resolved, 43 prices fresh.

While off, `priceDiff × lots × contractSize` was written into a dollar balance
while denominated in the **quote** currency. 31 of 45 instruments affected.

Verified on a real trade through the live HTTP path, engine and database:

```
USDJPY, 1 lot, opened 158.471, closed 158.478
gross               700.00 JPY
/ 158.478           $4.42
− $3.00 commission  $1.42      <- booked
balance             10000.00 -> 10001.42
```

The same trade under the old maths books **$697.00** — a 491× overstatement on
one 0.7-pip position. `VITE_FX_CONVERSION_ENABLED` set in step; out of step, the
terminal shows one number and the balance moves by another.

---

## Test results

Every line below was run; nothing is asserted from reading.

```
Backend unit + integration ...... PASS   445 passed,  0 failed,  0 skipped
Frontend unit ................... PASS    77 passed,  0 failed
Frontend production build ....... PASS    built in 7.11s
Backend lint .................... PASS     0 errors, 44 warnings
Frontend lint ................... PASS     0 errors, 160 warnings
npm run check ................... PASS
Schema verify (fresh provision) . PASS
SQL column check ................ PASS   704 columns checked
SQL prepare check ............... PASS   460 statements planned by Postgres
Authorization matrix ............ PASS   2,352 assertions, 0 violations
Money integrity ................. PASS
Race conditions ................. PARTIAL 3 of 4 proven, 1 unverified (U-1)
Security audit .................. PASS     0 issues
npm audit (prod) ................ PASS     0 vulnerabilities
Deploy preflight (permissive) ... PASS
Deploy preflight (strict) ....... FAIL     2 blockers — both operational, listed above
```

### Red-team results

| Attack | Result |
|---|---|
| JWT `alg=none` forgery claiming super_admin | 403 |
| Signature stripped from a real token | 403 |
| Payload tampered, original signature kept | 403 |
| Trader token replayed on the admin surface | 403 |
| SQL injection × 4 payloads on a public route | 400 — 82 users still present |
| Path traversal on `/uploads` | 404 / 400 |
| User enumeration via login | Identical 401 and message |
| User enumeration via password reset | Neutral message |
| Cookie flags | HttpOnly, SameSite=Strict, `secure` gated on production |
| Security headers | CSP, HSTS preload, X-Frame-Options DENY, nosniff, Referrer-Policy |
| Registration flood | Limiter held (5/hour) |
| Request flood | Abuse detector IP-blocked at 600/min |

---

## Deployment verdict

**READY WITH CONDITIONS.**

Nothing in the code blocks a deploy. The two conditions are operational:

1. **Revoke the GitHub PAT** — I removed it from `.git/config`; only you can
   revoke it.
2. **Enrol admin 2FA**, then confirm `DEPLOY_CHECK_STRICT=1 npm run
   deploy:preflight` passes.

And one judgement call worth making deliberately: **U-1**. The payout lock is
probably fine, but "probably" is the wrong word for a double-payout path, and a
two-connection test would settle it in an afternoon.

---

*Every finding here was produced by running the software, not by reading it.
The static signals were clean before this audit and are clean after it — which
is precisely why they should not be mistaken for evidence.*
