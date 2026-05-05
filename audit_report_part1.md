# TECHNICAL AUDIT REPORT — Part 1 of 3

### Project: PropFirm Trading Platform
### Audited By: Claude Opus — Principal Engineer Review
### Date: April 22, 2026
### Prepared For: Engineering Team & CTO

---

## EXECUTIVE SUMMARY

### What This Project Is

PropFirm is a **multi-tenant proprietary trading SaaS platform** that enables trading firms to run challenge-based funded trader programs. Retail traders purchase challenge accounts, prove their trading ability through Phase 1 and Phase 2 evaluations with defined profit targets and drawdown limits, and upon passing are awarded simulated funded accounts where they share profits with the firm. The platform handles the complete lifecycle: user registration with KYC verification, account provisioning, real-time trade execution against live MT5 price feeds, automated rule enforcement (drawdown breaches, inactivity, opposing trade detection), profit sharing payouts, and a white-label multi-tenant architecture allowing multiple firms to operate on a single deployment.

### Overall Health Score: **8.4 / 10**

**Justification:** The codebase demonstrates strong architectural fundamentals — comprehensive rate limiting, server-side abuse detection, Decimal.js financial arithmetic, transactional trading operations with row-level locks, and thoughtful multi-tenant isolation. However, two **critical runtime bugs** (undefined variable references in core trading paths) that would crash production, combined with missing graceful shutdown handlers and several medium-severity tenant isolation gaps, prevent a higher score. The security posture is excellent (bcryptjs, JWT+2FA, token versioning, CSP headers, parameterized queries) but the operational resilience layer needs hardening before institutional-grade launch.

### Top 3 Critical Issues

1. **BUG-001 (CRITICAL):** `totalPnl` undefined in `autoCloseAndFail()` — causes silent balance corruption on every floating drawdown breach. *Fixed during this audit.*
2. **BUG-002 (CRITICAL):** `tradeIp` undefined in `POST /api/trades/open` — causes `ReferenceError` crash on every trade open attempt. *Fixed during this audit.*
3. **BUG-003 (HIGH):** Missing `SIGINT` handler + no `unhandledRejection` handler — process crashes silently on Ctrl+C (Windows) and unhandled promises in Node 15+. *Fixed during this audit.*

### Top 3 Strengths

1. **Transaction discipline:** Every balance-affecting operation uses `BEGIN/COMMIT` with `FOR UPDATE SKIP LOCKED`, advisory locks for account creation, and idempotency keys for replay safety.
2. **Security depth:** 7-layer security stack (Helmet CSP, rate limiting per action type, server-side abuse detection, JWT+2FA with instant revocation via token versioning, bcryptjs password hashing, parameterized SQL, file upload validation).
3. **Multi-tenant architecture:** Clean tenant isolation via middleware (`attachTenantContext`), consistent `tenant_id` filtering on all queries, per-tenant settings/feeds/admin portals, and dedicated price feed sources per tenant.

### Technical Debt Estimate: **~80-120 developer-hours**

| Category | Hours | Priority |
|---|---|---|
| Extract background jobs to BullMQ workers | 24-32 | P2 |
| Integration test suite for trading engine | 16-24 | P1 |
| Wire drawdown type settings (trailing vs static) | 8-12 | P2 |
| Move DDL operations to migration system | 4-8 | P1 |
| Connection pool tuning + monitoring | 4-6 | P2 |
| Horizontal scaling preparation (Redis-backed locks) | 16-24 | P3 |
| Dependency audit + upgrade cycle | 4-8 | P1 |

### Overall Risk Assessment: **MEDIUM**

The two critical bugs have been patched during this audit session. Remaining risks are operational (scalability under high concurrent load, single-process background job architecture) rather than correctness risks. The platform is **conditionally production-ready** after verifying all patches and completing the P1 backlog items.

### Recommended Immediate Next Steps

1. Verify all 7 bug fixes applied during this audit by running `node --check` on all modified files
2. Run the integration test suite against the patched trading engine
3. Execute `npm audit` and update any critical dependency CVEs
4. Populate all `platform_settings` values in the database before enabling live funded accounts
5. Deploy to staging and run a full regression test under simulated concurrent load

---

## SECTION 1: PROJECT ANATOMY

### 1.1 Project Overview

**Purpose:** PropFirm provides a turnkey SaaS solution for proprietary trading firms to run funded trader challenge programs. The platform manages the complete business workflow from trader onboarding through profit payouts.

**End Users:**
- **Retail Traders:** Register, complete KYC, purchase challenges, execute trades, track progress, request payouts
- **Firm Administrators (Tenant Admins):** Manage traders, configure challenge rules, review KYC, approve payouts, monitor violations
- **Platform Super Admins:** Manage tenants, global settings, price feed sources, system health monitoring

**Core Workflows Mapped to Code:**

| Workflow | Primary Files | Database Tables |
|---|---|---|
| User Registration + KYC | `routes/auth.js`, `routes/kyc.js` | `users`, `kyc_documents` |
| Challenge Purchase + Account Creation | `routes/accounts.js`, `routes/billing.js` | `accounts`, `challenge_orders` |
| Trade Execution (Open/Close/Modify) | `routes/trades.js` | `trades`, `trade_logs` |
| Real-time Price Feed | `priceFeed.js`, `utils/tenantFeeds.js` | `price_feed`, `price_history` |
| Automated Rule Enforcement | `challengeEngine.js`, `routes/trades.js` | `admin_rule_violations`, `admin_enforcement_events` |
| Account Progression (Phase1→Phase2→Funded) | `services/progressionService.js` | `accounts`, `bbook_pnl` |
| Drawdown Monitoring | `routes/trades.js:checkFloatingDrawdown` | `accounts` (balance/peak updates) |
| News Force-Close | `server.js:checkNewsForceClose` | `trades`, `accounts` |
| Weekend Flat-lining | `server.js:weekendForceClose` | `trades`, `accounts` |
| Payout Processing | `routes/payouts.js` | `payouts` |
| Multi-tenant Management | `utils/tenants.js`, `routes/adminTenants.js` | `tenants`, `tenant_settings` |
| Violation & Anti-Gaming | `services/violationEngine.js`, `challengeEngine.js` | `admin_rule_violations` |

---

### 1.2 Tech Stack Inventory

| Category | Technology | Version | Purpose | Notes |
|---|---|---|---|---|
| **Runtime** | Node.js | 18+ | Server runtime | CommonJS modules |
| **Framework** | Express | 5.2.1 | HTTP routing | Latest major version |
| **Database** | PostgreSQL | 16 | Primary data store | Alpine Docker image |
| **DB Driver** | pg | 8.18.0 | PostgreSQL client | Connection pooling |
| **Migrations** | Knex | 3.1.0 | Schema migrations | Separate from DDL-in-code pattern |
| **Cache/Session** | Redis | 7 (server) / 5.11.0 (client) | Token caching, session store | Alpine Docker image |
| **WebSocket** | Socket.io | 4.8.3 | Real-time price/trade updates | Bidirectional |
| **Auth - Passwords** | bcryptjs | 3.0.3 | Password hashing | Also has `bcrypt` 6.0 (native) |
| **Auth - JWT** | jsonwebtoken | 9.0.3 | Token signing/verification | Separate user + admin secrets |
| **Auth - 2FA** | speakeasy | 2.0.0 | TOTP generation/verification | With QR code via `qrcode` |
| **Financial Math** | Decimal.js | 10.6.0 | Precise decimal arithmetic | Used in all PnL calculations |
| **Security Headers** | Helmet | 8.1.0 | CSP, HSTS, X-Frame-Options | Strict configuration |
| **Rate Limiting** | express-rate-limit | 8.3.1 | Per-user/IP throttling | v7+ API with ipKeyGenerator |
| **Email** | Nodemailer | 8.0.1 | Password reset, notifications | SMTP transport |
| **HTTP Client** | Axios | 1.13.5 | ForexFactory news API | With timeout |
| **Scheduling** | node-cron | 4.2.1 | Periodic tasks | Challenge engine, price pruning |
| **File Upload** | Multer | 2.0.2 | KYC document uploads | Size + type validation |
| **Logging** | Winston | 3.19.0 | Structured logging | File + console transports |
| **Message Queue** | KafkaJS | 2.2.4 | Event streaming (optional) | Graceful degradation if unavailable |
| **UUID** | uuid | 13.0.0 | Unique identifiers | Account UIDs, idempotency keys |
| **API Docs** | swagger-ui-express | 5.0.1 | Swagger UI hosting | Auto-generated routes |
| **Containerization** | Docker Compose | 3.9 | Multi-service orchestration | PostgreSQL, Redis, Nginx, App |
| **Reverse Proxy** | Nginx | 1.25 | TLS termination, routing | Alpine image |
| **Dev Tools** | Nodemon | 3.1.14 | Hot reload | Dev dependency only |
| **Frontend** | React | (separate) | SPA trader dashboard | Create React App |

---

### 1.3 Architecture Pattern

**Pattern:** Multi-tenant modular monolith with real-time WebSocket layer

The application follows a **modular monolith** pattern where all business logic runs in a single Node.js process, organized into route modules, service layers, and utility libraries. Background jobs (SL/TP checking, drawdown monitoring, pending order activation, challenge engine) run as `setInterval` loops within the same process.

**ASCII Architecture Diagram:**

```
┌──────────────────────────────────────────────────────────────────────┐
│                         NGINX REVERSE PROXY                         │
│                    (TLS termination, static files)                   │
│                         Ports 80 / 443                               │
└──────────────┬────────────────────────────────┬──────────────────────┘
               │ HTTP /api/*                    │ Static Assets
               ▼                                ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│      EXPRESS BACKEND     │      │     REACT FRONTEND       │
│      (Node.js 18+)       │      │     (Create React App)   │
│                          │      │                          │
│  ┌────────────────────┐  │      │  SPA served by Nginx     │
│  │  Middleware Stack   │  │      └──────────────────────────┘
│  │  ├─ Helmet (CSP)    │  │
│  │  ├─ CORS            │  │
│  │  ├─ Abuse Detector  │  │
│  │  ├─ Rate Limiters   │  │
│  │  ├─ Tenant Context  │  │
│  │  └─ Body Parser     │  │
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │      ┌──────────────────────────┐
│  │  Route Modules     │  │      │       SOCKET.IO          │
│  │  ├─ auth.js        │  │◄────►│  (Real-time bidirectional)│
│  │  ├─ accounts.js    │  │      │  ├─ Price feed streaming  │
│  │  ├─ trades.js      │  │      │  ├─ Trade notifications   │
│  │  ├─ admin.js       │  │      │  ├─ Account updates       │
│  │  ├─ payouts.js     │  │      │  └─ Admin alerts          │
│  │  ├─ kyc.js         │  │      └──────────────────────────┘
│  │  ├─ billing.js     │  │
│  │  └─ chat.js        │  │
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │ Background Jobs    │  │
│  │ (setInterval)      │  │
│  │ ├─ checkSLTP()     │  │──── 500ms cycle
│  │ ├─ checkPending()  │  │──── 1000ms cycle
│  │ ├─ checkDrawdown() │  │──── 1000ms cycle
│  │ ├─ priceFeed       │  │──── fs.watch + polling
│  │ ├─ newsForceClose  │  │──── 30s cycle
│  │ ├─ weekendClose    │  │──── 10s cycle (Fri only)
│  │ └─ challengeEngine │  │──── cron (hourly)
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │ Services           │  │
│  │ ├─ newsService     │  │
│  │ ├─ progressionSvc  │  │
│  │ ├─ violationEngine │  │
│  │ └─ tenantPolicySvc │  │
│  └────────────────────┘  │
└──────────┬───────────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
┌──────────┐ ┌──────────┐
│PostgreSQL│ │  Redis   │
│   16     │ │    7     │
│          │ │          │
│ accounts │ │ token    │
│ trades   │ │ cache    │
│ users    │ │ (5min    │
│ price_*  │ │  TTL)    │
│ tenants  │ │          │
└──────────┘ └──────────┘
```

**Request Lifecycle (Trade Open):**

1. Client sends `POST /api/trades/open` with JWT Bearer token
2. Nginx routes to Express backend
3. `attachTenantContext` middleware resolves tenant from hostname/header
4. `authenticateToken` verifies JWT, checks token_version (Redis cache → DB fallback), checks ban status
5. `tradingLimiter` rate-limits to 30 trades/min per user
6. Handler validates inputs, checks news events, verifies account ownership + status
7. `pg_advisory_xact_lock` prevents concurrent opens for same user+account
8. Transaction: lock account `FOR UPDATE`, validate margin, insert trade, update balance
9. `COMMIT` → respond 201 → emit Socket.io `account_update` event
10. Background `checkSLTP` loop (500ms) monitors for SL/TP hits on the new trade

---

### 1.4 Codebase Structure

```
e:\propfirm\
├── backend/                          # Node.js API server
│   ├── server.js              (69KB) # Main entry: Express setup, background jobs, WebSocket
│   ├── challengeEngine.js     (37KB) # Automated challenge rule enforcement
│   ├── priceFeed.js           (24KB) # MT5 price feed ingestion + history
│   ├── db.js                  (928B) # PostgreSQL connection pool
│   ├── env.js                 (1.4KB)# Environment variable validation
│   ├── constants.js           (2.7KB)# Shared constants, re-exports instruments
│   ├── instruments.js         (5.3KB)# Instrument definitions, contract sizes, pip sizes
│   ├── mailer.js              (12KB) # Email templates + SMTP transport
│   ├── knexfile.js            (603B) # Knex migration configuration
│   │
│   ├── routes/                       # Express route modules
│   │   ├── trades.js         (128KB) # ⚠️ LARGEST FILE — trade execution, SL/TP, drawdown
│   │   ├── admin.js          (177KB) # Admin dashboard endpoints
│   │   ├── accounts.js        (44KB) # Account creation, stats, rules
│   │   ├── auth.js            (37KB) # Registration, login, 2FA, password reset
│   │   ├── billing.js         (32KB) # Payment processing, Stripe integration
│   │   ├── chat.js            (24KB) # Support chat system
│   │   ├── payouts.js         (22KB) # Profit withdrawal requests
│   │   ├── adminTenants.js    (14KB) # Tenant management endpoints
│   │   ├── setup.js           (14KB) # Platform setup wizard
│   │   ├── middleware.js      (12KB) # Auth middleware (JWT, admin, pre-2FA)
│   │   ├── swagger.js         (10KB) # API documentation
│   │   ├── kyc.js             (10KB) # KYC document upload + review
│   │   ├── importMT5History.js (8KB) # MT5 trade history import
│   │   ├── copier-routes.js   (8KB)  # Trade copier endpoints
│   │   ├── adminViolations.js (4KB)  # Violation management
│   │   ├── disputes.js        (4KB)  # Trade dispute handling
│   │   └── tenant.js          (702B) # Tenant info endpoint
│   │
│   ├── services/                     # Business logic services
│   │   ├── violationEngine.js (9.5KB)# Rule violation recording + enforcement
│   │   ├── newsService.js     (8KB)  # ForexFactory calendar integration
│   │   ├── progressionService.js(6KB)# Phase1→Phase2→Funded progression
│   │   └── tenantPolicyService.js(2KB)# Tenant-specific settings resolver
│   │
│   ├── utils/                        # Shared utilities
│   │   ├── tenantFeeds.js     (13KB) # Per-tenant price feed management
│   │   ├── tenants.js         (11KB) # Tenant resolution + CORS
│   │   ├── tenantSettings.js  (10KB) # Tenant settings cache
│   │   ├── security.js        (8KB)  # Rate limiters, abuse detection, Helmet
│   │   ├── secrets.js         (7KB)  # Secrets management (env/AWS/Vault)
│   │   ├── performance.js     (7KB)  # Performance monitoring + metrics
│   │   ├── totp.js            (5KB)  # TOTP 2FA utilities
│   │   ├── tokenCache.js      (5KB)  # Redis-backed JWT token cache
│   │   ├── validation.js      (5KB)  # Input validation + sanitization
│   │   ├── logger.js          (5KB)  # Winston logger configuration
│   │   ├── kafka.js           (3KB)  # Kafka producer (optional)
│   │   ├── idempotency.js     (3KB)  # Request idempotency layer
│   │   ├── dbMigration.js     (2KB)  # Migration helper
│   │   ├── advisoryLock.js    (1KB)  # PostgreSQL advisory lock wrapper
│   │   ├── pendingOrderValidation.js(1KB) # Pending order price validation
│   │   ├── realtime.js        (617B) # Socket.io event emitter
│   │   └── chartTimeframes.js (439B) # Chart timeframe constants
│   │
│   ├── config/                       # Configuration files
│   ├── migrations/                   # Knex migration files
│   ├── seeds/                        # Database seed data
│   ├── scripts/                      # Utility scripts
│   ├── test/                         # Test files
│   ├── tools/                        # Development tools
│   ├── trade-copier/                 # Trade copier module
│   └── uploads/                      # KYC document storage
│
├── frontend/                         # React SPA
├── deploy/                           # Deployment configs (Nginx, certs)
├── docker-compose.yml                # Multi-service orchestration
└── docs/                             # Documentation
```

**Structural Concerns:**

1. **`trades.js` at 128KB (2393 lines)** is too large for a single module. It contains trade execution, SL/TP checking, drawdown monitoring, analytics, batch operations, and the trade journal — these should be split into separate modules.
2. **`admin.js` at 177KB** is the largest file in the project and should be decomposed by feature area (user management, account management, analytics, settings).
3. **`server.js` at 69KB** contains business logic (news force-close, weekend close, support tickets) that should be extracted into route modules or services.
4. **DDL-in-code pattern** — Multiple files run `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` at request time rather than using the established Knex migration system.

---

### 1.5 Data Flow Analysis

**Data Entry Points:**

| Entry Point | Validation | Transformation | Persistence |
|---|---|---|---|
| HTTP REST API | `sanitizeString`, `isValidEmail`, `isValidLotSize`, type coercion | Input normalization, Decimal.js conversion | Parameterized PostgreSQL queries |
| WebSocket | JWT-authenticated connections | Event parsing | Emits only (no direct DB writes) |
| MT5 File Watch | `readDWXFileSafe` with retry | Price parsing, spread markup | Bulk INSERT via `upsertSourcePrices` |
| ForexFactory API | Array validation, country filtering | Timestamp normalization | UPSERT into `news_cache` |
| File Uploads (KYC) | Size limit (10MB), MIME type, extension check | Multer disk storage | Filesystem + DB reference |

**Data Corruption Risks:**

1. ✅ **Mitigated:** Financial calculations use `Decimal.js` to avoid floating-point drift
2. ✅ **Mitigated:** Balance updates are atomic within transactions with `FOR UPDATE` locks
3. ⚠️ **Partial:** The `autoCloseAndPass` trade loop catches errors per-trade but continues — if one trade fails to close, the accumulated PnL is incorrect and the final balance update will be wrong
4. ✅ **Mitigated:** Idempotency layer prevents duplicate account creation and trade opens
5. ✅ **Mitigated:** Advisory locks prevent TOCTOU races in account creation quota checks
