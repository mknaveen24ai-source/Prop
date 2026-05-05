# TECHNICAL AUDIT REPORT — Part 3 of 3

## SECTION 4: PERFORMANCE AUDIT

### 4.1 Backend Performance

---

#### PERF-001
- **Type:** DDL Lock Contention Per Request
- **Severity:** HIGH
- **File:** `routes/trades.js:1932-1934`, `services/violationEngine.js:19-104`, `services/newsService.js:22-44`
- **Impact:** Multiple files run `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS` at request time. These DDL operations acquire `ACCESS EXCLUSIVE` locks on the target tables, blocking all concurrent queries momentarily.

**Files with Runtime DDL:**

| File | DDL Operation | Table Locked | Frequency |
|---|---|---|---|
| `violationEngine.js:22-104` | CREATE TABLE × 3, CREATE INDEX × 5, ALTER TABLE × 2 | `admin_rules`, `admin_rule_violations`, `admin_enforcement_events`, `accounts` | First request after restart |
| `newsService.js:25-37` | CREATE TABLE × 1, CREATE INDEX × 1 | `news_cache` | First call |
| `trades.js:1933` | ALTER TABLE × 1 | `trades` | **Every PATCH /note call** ⚠️ |

**Slow Code:**
```javascript
// violationEngine.js — 10 DDL statements on first call
async function ensureViolationTables() {
  if (_violationTablesReady) return  // ✅ Has a guard flag
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_rules (...)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS ...`)
  // ... 8 more DDL statements sequentially
}
```

**Optimized Code:** Move all DDL to Knex migrations:
```javascript
// migrations/20260422_create_violation_tables.js
exports.up = function(knex) {
  return knex.schema
    .createTableIfNotExists('admin_rules', (t) => { ... })
    .createTableIfNotExists('admin_rule_violations', (t) => { ... })
    .createTableIfNotExists('admin_enforcement_events', (t) => { ... })
}
```

**Impact Metrics:** Each DDL statement adds ~5-20ms latency and blocks all concurrent queries on the locked table. With 10 sequential DDL statements, the first violation recording after restart can take 50-200ms and stall all concurrent account queries.

---

#### PERF-002
- **Type:** Missing Connection Pool Configuration
- **Severity:** MEDIUM
- **File:** `db.js:7-10`
- **Impact:** The PostgreSQL pool uses default settings (`max: 10` connections, no `idleTimeoutMillis`, no `connectionTimeoutMillis`). Under concurrent load with 50+ traders, the 10-connection limit becomes a bottleneck. Background jobs (SL/TP check, drawdown check, pending orders, challenge engine) all compete with API requests for connections.

**Current Code:**
```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  allowExitOnIdle: true
})
```

**Recommended Configuration:**
```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || '25', 10),
  min: parseInt(process.env.PG_POOL_MIN || '5', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true,
  statement_timeout: 30000  // Kill queries running > 30s
})
```

**Impact Metrics:** With default `max: 10`, a burst of 15 concurrent trade opens will queue 5 of them waiting for a free connection. Each queued request adds ~50-500ms latency depending on how quickly connections are released.

---

#### PERF-003
- **Type:** Unbounded Query — Missing Pagination
- **Severity:** MEDIUM
- **File:** `routes/trades.js:checkPendingOrders`, `routes/trades.js:checkSLTP`
- **Impact:** The background jobs query ALL open/pending trades system-wide with no LIMIT clause. As the platform grows to 10,000+ open trades, each 500ms cycle loads all of them into memory.

**Current Code:**
```javascript
// checkPendingOrders — loads ALL pending orders
const pendingOrders = await pool.query(
  `SELECT t.id, t.account_id, t.instrument, ... FROM trades t
   JOIN accounts a ON t.account_id = a.id
   WHERE t.status = 'pending'`   // ❌ No LIMIT
)
```

**Recommended Fix:** Add pagination or batch processing:
```javascript
// Process in batches of 500
const BATCH_SIZE = 500
let offset = 0
let hasMore = true

while (hasMore) {
  const batch = await pool.query(
    `SELECT ... FROM trades t ... WHERE t.status = 'pending'
     ORDER BY t.id LIMIT $1 OFFSET $2`,
    [BATCH_SIZE, offset]
  )
  // ... process batch ...
  hasMore = batch.rows.length === BATCH_SIZE
  offset += BATCH_SIZE
}
```

---

#### PERF-004
- **Type:** Sequential Network Requests in Price Feed Cache
- **Severity:** MEDIUM
- **File:** `services/newsService.js:100-111`
- **Impact:** When persisting fetched news events to the database cache, each event is inserted individually with `await pool.query(...)` in a sequential loop. With 20-30 events per fetch, this takes 20-30 round trips.

**Current Code:**
```javascript
for (const evt of parsed) {
  try {
    await pool.query(       // ❌ Sequential INSERT per event
      `INSERT INTO news_cache ...`,
      [evt.title, evt.country, evt.impact, ...]
    )
  } catch (_) {}
}
```

**Optimized Code:** Use a single bulk UPSERT:
```javascript
if (parsed.length > 0) {
  const values = parsed.map((_, i) =>
    `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4}::timestamptz, NOW())`
  ).join(', ')
  const params = parsed.flatMap(evt => [evt.title, evt.country, evt.impact, new Date(evt.timestamp).toISOString()])

  await pool.query(
    `INSERT INTO news_cache (title, country, impact, event_time, fetched_at)
     VALUES ${values}
     ON CONFLICT (title, event_time) DO UPDATE SET fetched_at = NOW()`,
    params
  )
}
```

---

#### PERF-005
- **Type:** Memory Leak Risk — In-Memory Maps Without Bounds
- **Severity:** LOW
- **File:** `utils/security.js:137-169`, `routes/trades.js:58-59`
- **Impact:** The `abusiveIPs` Map, `ipRequestCounts` Map, and `_tradingRulesCache` Map all grow in memory. While cleanup mechanisms exist (periodic timers, TTL checks), under a DDoS attack the `ipRequestCounts` Map could grow unboundedly within its 60-second window before clearing.

**Mitigation already in place:** The `abusiveIPs` map has a 10,000-entry cap with LRU eviction. The `ipRequestCounts` map clears every 60 seconds. The trading rules cache is keyed by tenant ID (bounded by number of tenants).

**Remaining risk:** A sustained DDoS from millions of unique IPs could push `ipRequestCounts` to 1M+ entries, consuming ~200MB of memory in the 60-second window before cleanup. Consider using a fixed-size LRU cache instead.

---

#### PERF-006
- **Type:** Advisory Lock Connection Leak Risk
- **Severity:** LOW
- **File:** `utils/advisoryLock.js:10-41`
- **Impact:** The `withAdvisoryLock` function uses a session-level advisory lock (`pg_try_advisory_lock`) on a dedicated connection. If the callback `fn()` throws and the unlock query also fails in the `finally` block, the lock remains held on that connection until the connection is released to the pool. Since the pool reuses connections, the lock may persist and block future callers.

**Current implementation is adequate** because: (1) `client.release()` always runs in the `finally` block, (2) session-level locks are automatically released when the connection closes, (3) the pool recycles connections. However, for maximum safety, consider using transaction-level locks (`pg_advisory_xact_lock`) which are automatically released on COMMIT/ROLLBACK.

---

#### PERF-007
- **Type:** Synchronous File I/O in Price Feed
- **Severity:** LOW
- **File:** `priceFeed.js:74-75`
- **Impact:** `fs.readFileSync` blocks the event loop during MT5 file reads. The retry mechanism (50ms delay, 3 retries) uses `setTimeout` correctly, but the synchronous read itself blocks the event loop for the duration of the I/O operation.

**Current Code:**
```javascript
function readDWXFileSafe(filePath, maxRetries = 3, delayMs = 50) {
  return new Promise((resolve, reject) => {
    function attempt() {
      try {
        const raw = fs.readFileSync(filePath, 'utf8').trim()  // ❌ Blocks event loop
        resolve(raw)
      } catch (err) { ... }
    }
    attempt()
  })
}
```

**Impact:** The MT5 market data file is typically <50KB, so the blocking duration is <1ms per read. This is acceptable for the current scale. At scale (1000+ instruments), consider switching to `fs.promises.readFile`.

---

## SECTION 5: CODE QUALITY ASSESSMENT

### 5.1 Code Metrics

| Metric | Value | Assessment |
|---|---|---|
| Total backend lines of code | ~15,000+ | Large but organized |
| Largest file (admin.js) | 177KB / ~4,500 lines | ❌ Needs decomposition |
| Second largest (trades.js) | 128KB / ~2,400 lines | ❌ Needs decomposition |
| Third largest (server.js) | 69KB / ~1,775 lines | ⚠️ Some extraction needed |
| Total route modules | 15 | Well-modularized |
| Total utility modules | 14 | Good reuse patterns |
| Total service modules | 4 | Appropriate layer |
| Test coverage | Low — only basic test files present | ❌ Needs improvement |
| ESLint configuration | None found | ⚠️ Should be added |

### 5.2 Complexity Analysis

| File | Cyclomatic Complexity | Reasoning |
|---|---|---|
| `trades.js:checkFloatingDrawdown` | Very High (~25) | Multiple nested loops, condition chains for drawdown types, account types |
| `challengeEngine.js:runChallengeEngine` | Very High (~30) | Processes all active accounts with multiple rule checks per account |
| `server.js:weekendForceClose` | High (~15) | Date calculations, market status checks, trade filtering |
| `routes/auth.js:POST /login` | Medium (~10) | Ban check, 2FA check, token version, tenant validation |
| `utils/security.js:abuseDetector` | Medium (~8) | Map lookups, TTL checks, cleanup logic |

### 5.3 Documentation Quality

| Area | Coverage | Notes |
|---|---|---|
| Module-level comments | ✅ Good | Most files have header comments explaining purpose |
| Function-level JSDoc | ⚠️ Partial | Core utilities have docs, routes mostly don't |
| Inline comments | ✅ Excellent | Fix annotations (FIX, BUG-xxx, AUDIT) explain rationale |
| API documentation | ✅ | Swagger UI available at `/api/docs` |
| Architecture docs | ✅ | `PROJECT_SYSTEM_DOCUMENTATION.md` at project root |

### 5.4 Dead Code & Unused Exports

| Item | File | Type |
|---|---|---|
| `bcrypt` package | `package.json` | Unused dependency |
| `MIGRATION_INSTALL_SUMMARY.js` | Backend root | Historical artifact — should be in docs/ |
| Various `SETUP.md` files | Backend root | Should be consolidated into docs/ |

---

## SECTION 6: REMEDIATION ROADMAP

### Sprint 1 — Critical Fixes (COMPLETED)

| Bug ID | Fix | Status |
|---|---|---|
| BUG-001 | Added `totalPnl` conversion in `autoCloseAndFail` | ✅ Applied |
| BUG-002 | Added `tradeIp` declaration in `/open` handler | ✅ Applied |
| BUG-003 | Added SIGINT + unhandledRejection handlers | ✅ Applied |
| BUG-004 | Changed post-COMMIT query to `pool.query` | ✅ Applied |
| BUG-005 | Added tenant_id filter to cancel endpoint | ✅ Applied |

### Sprint 2 — High Priority (1-2 weeks)

| Item | Effort | Description |
|---|---|---|
| Move DDL to migrations | 4h | Move all runtime DDL from violationEngine, newsService, trades.js /note to Knex migrations or server startup |
| Remove `bcrypt` dependency | 15min | `npm uninstall bcrypt` |
| Add `node --check` to CI | 30min | Add syntax validation for all critical files to prevent undefined variable deployments |
| Run `npm audit --fix` | 1h | Address any known dependency CVEs |
| Integration test: autoCloseAndFail | 4h | End-to-end test: create account → open trade → simulate drawdown → verify balance, violations, status |
| Integration test: trade open flow | 4h | End-to-end test: login → open trade → verify trade_logs entry with IP → close trade → verify PnL |

### Sprint 3 — Medium Priority (2-4 weeks)

| Item | Effort | Description |
|---|---|---|
| PG pool configuration | 2h | Add configurable pool settings (max, min, timeouts, statement_timeout) |
| Wire drawdown type settings | 8h | Connect `phase1_drawdown_type` from progressionService to actual drawdown checks |
| Decompose trades.js | 16h | Split into trade-execution.js, trade-analytics.js, trade-monitoring.js |
| Add ESLint configuration | 2h | Configure `no-undef`, `no-unused-vars`, `prefer-const` rules |
| Redis-backed rate limiting | 4h | Replace in-memory Maps with Redis store for horizontal scaling |

### Sprint 4 — Architecture Evolution (4-8 weeks)

| Item | Effort | Description |
|---|---|---|
| Extract background jobs to BullMQ | 24h | Move checkSLTP, checkPendingOrders, checkFloatingDrawdown, challengeEngine to worker processes |
| Add centralized logging (Sentry/Datadog) | 8h | Winston transport for production error aggregation |
| Admin audit trail | 16h | Log all admin actions (payout approvals, setting changes, user modifications) |
| Decompose admin.js | 16h | Split 177KB admin.js into feature-specific modules |
| Load testing suite | 8h | Simulate 500+ concurrent traders to identify bottlenecks |

---

## SECTION 7: VERIFICATION CHECKLIST

### Post-Audit Verification Steps

```bash
# 1. Syntax validation on all modified files
node --check backend/routes/trades.js
node --check backend/routes/accounts.js
node --check backend/server.js

# 2. Dependency audit
cd backend && npm audit

# 3. Start the server and verify no crashes
npm run dev

# 4. Manual verification matrix
```

| Test Case | Expected Behavior | Priority |
|---|---|---|
| Open a trade | 201 Created, trade appears in dashboard, trade_log has IP | P0 |
| Trigger floating drawdown breach | Account set to 'failed', all trades closed, violation recorded, Socket.io notification sent | P0 |
| Ctrl+C on Windows | "SIGINT received, shutting down gracefully..." logged | P0 |
| Cancel a pending order | Order cancelled, only own-tenant orders visible | P1 |
| Save a trade note | Note saved without DDL lock (if moved to startup) | P1 |
| Create account from challenge order | Order metadata updated with account_id | P1 |

---

## APPENDIX A: FILES MODIFIED DURING AUDIT

| File | Changes | Bug IDs |
|---|---|---|
| `routes/trades.js` | Restored autoCloseAndFail body, added totalPnl conversion, added tradeIp declaration, added tenant_id to cancel | BUG-001, BUG-002, BUG-005 |
| `routes/accounts.js` | Changed post-COMMIT client.query to pool.query with error isolation | BUG-004 |
| `server.js` | Added SIGINT handler, unhandledRejection/uncaughtException handlers | BUG-003 |

---

## APPENDIX B: SCORING BREAKDOWN

| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Architecture & Design | 9.5 / 10 | 25% | 2.375 |
| Security Posture | 9.4 / 10 | 20% | 1.880 |
| Trading Engine Correctness | 8.5 / 10 | 20% | 1.700 |
| Database & Performance | 9.2 / 10 | 15% | 1.380 |
| Code Quality & Maintainability | 7.5 / 10 | 10% | 0.750 |
| Observability & Operations | 8.0 / 10 | 10% | 0.800 |
| **TOTAL** | | **100%** | **8.885 → 8.4/10** |

The 0.485 deduction accounts for: (1) the two critical runtime bugs that would crash production, (2) the 128KB single-file trade module, (3) missing ESLint/linting configuration, and (4) low test coverage.

---

*End of Technical Audit Report*
*Report generated: April 22, 2026*
*Total audited files: 24 source files across routes, services, and utilities*
*Total bugs identified: 12 (2 CRITICAL, 2 HIGH, 4 MEDIUM, 4 LOW)*
*Total security vulnerabilities: 2 (1 MEDIUM, 1 LOW)*
*Total performance issues: 7 (1 HIGH, 3 MEDIUM, 3 LOW)*
*Fixes applied during audit: 5 of 12 bugs resolved*
