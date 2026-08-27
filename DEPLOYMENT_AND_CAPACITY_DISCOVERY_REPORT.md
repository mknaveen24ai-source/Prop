# PLATFORM DEPLOYMENT & CAPACITY DISCOVERY REPORT

**Target Audience:** Infrastructure Architect, DevOps Engineer & Cloud Sizing AI Models  
**Repository Inspected:** Prop-Firm & Trading Platform  
**Analysis Scope:** Complete codebase (`backend/`, `frontend/`, `deploy/`, `contracts/`, `dwxconnect-main/`)  
**Document Purpose:** Code-backed architectural topology, runtime specifications, trading & risk engine mechanics, database sizing, and hosting capacity analysis for deployment and cloud credit utilization.

---

## TABLE OF CONTENTS
1. [Project Architecture](#1-project-architecture)
2. [Runtime Requirements](#2-runtime-requirements)
3. [Price-Feed Architecture](#3-price-feed-architecture)
4. [Trading Engine](#4-trading-engine)
5. [Challenge & Risk Engine](#5-challenge--risk-engine)
6. [Database (PostgreSQL)](#6-database-postgresql)
7. [Redis Infrastructure](#7-redis-infrastructure)
8. [Kafka & Queues](#8-kafka--queues)
9. [Socket.IO Realtime Infrastructure](#9-socketio-realtime-infrastructure)
10. [Frontend Realtime Behavior](#10-frontend-realtime-behavior)
11. [Storage & File Uploads](#11-storage--file-uploads)
12. [Payments, Email & Third-Party APIs](#12-payments-email--third-party-apis)
13. [Current Deployment Readiness](#13-current-deployment-readiness)
14. [Capacity Target Evaluation](#14-capacity-target-evaluation)
15. [Hosting Requirements & Sizing](#15-hosting-requirements--sizing)
16. [Free-Credit & Cloud Suitability](#16-free-credit--cloud-suitability)
17. [Information Still Needed (Gaps & Questions)](#17-information-still-needed-gaps--questions)

---

## 1. PROJECT ARCHITECTURE

### 1.1 Frontend Framework & Build Tool
* **Framework:** React `19.0.0` Single Page Application (SPA).
* **Build Tool:** Vite `8.0.1` (`@vitejs/plugin-react: ^6.0.0`).
* **Routing:** `react-router-dom: ^7.13.0` (Client-side routing with role-based auth guards for traders and platform admins).
* **State Management:** Zustand `5.0.3` (`zustand/middleware` devtools enabled in development mode).
* **Styling & Design System:** Pure Vanilla CSS with centralized CSS custom properties (`App.css`, `index.css`, `styles/`). TailwindCSS is **not** used.
* **UI Components & Visualization:**
  * Lucide React (`lucide-react: ^1.16.0`) for icon sets.
  * Recharts (`recharts: ^3.7.0`) for equity curves, drawdown gauges, and admin performance analytics.
  * Framer Motion (`framer-motion: ^12.34.0`) for UI transitions.
  * React Hot Toast (`react-hot-toast: ^2.6.0`) for notification toasts.
  * Embedded TradingView Advanced Chart Widget (`TradingViewWidget.jsx`) for live candlestick charts.
* **Entry Points:** `frontend/src/index.jsx`, `frontend/src/App.jsx`.

### 1.2 Backend Framework & Runtime
* **Runtime:** Node.js `24.19.0` (Enforced via `.node-version`, `backend/package.json` engines `"node": ">=24.19.0"`).
* **Framework:** Express `5.0.1` (`express: ^5.0.1`).
* **Language & Compilation:** TypeScript `5.7.3` source compiled via `tsc` to CommonJS / ES2022 output in `backend/dist/`.
* **Realtime Communication:** Socket.IO Server `4.8.1` (`@socket.io/redis-adapter: ^8.3.0` attached for horizontal scaling).
* **Database Driver:** `pg: ^8.13.1` (Native PostgreSQL client with connection pooling, read-replica pooling, and session advisory lock pooling).
* **In-Memory Cache & Bus Driver:** `redis: ^5.1.0` (Node-Redis client with pub/sub and standalone client duplication).
* **Validation & Precision Math:** Zod `3.24.1` for request schemas; Decimal.js `10.4.3` for financial and ledger calculations.

### 1.3 Monolith vs. Services Topology
The platform supports two deployment topologies determined by the `ROLE` environment variable (`backend/config/role.ts`):

```
                                  ┌────────────────────────┐
                                  │      Nginx / WAF       │
                                  │  (SSL, Rate Limit, WS) │
                                  └───────────┬────────────┘
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    │                         │                         │
            (HTTP /api/*)              (WS /socket.io/*)          (Internal Bus)
                    │                         │                         │
                    ▼                         ▼                         │
          ┌───────────────────┐     ┌───────────────────┐               │
          │   api instances   │     │ gateway instances │               │
          │  (Stateless HTTP) │     │ (Socket.IO Nodes) │               │
          └─────────┬─────────┘     └─────────┬─────────┘               │
                    │                         │                         │
                    │   Redis: trade-index    │   Redis: rt:price       │
                    │   mutations channel     │   rt:equity channels    │
                    ▼                         ▼                         │
          ┌─────────────────────────────────────────────┐               │
          │             Redis 7.x Cluster               │◄──────────────┤
          │    (Pub/Sub, Rate Limits, Token Blacklist)  │               │
          └──────────────────────┬──────────────────────┘               │
                                 │                                      │
                                 ▼                                      │
                    ┌─────────────────────────┐                         │
                    │     engine instance     │─────────────────────────┘
                    │ (Single-thread in-memory│
                    │  tradeIndex, SL/TP, PnL)│
                    └────────────┬────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 │                               │
                 ▼                               ▼
    ┌─────────────────────────┐     ┌─────────────────────────┐
    │  MetaTrader 5 Bridge    │     │  PostgreSQL 18 Primary  │
    │  (DWX File Watcher)     │     │  (With PgBouncer Pool)  │
    └─────────────────────────┘     └─────────────────────────┘
```

1. **Monolith Topology (`ROLE=all`):**
   * Single container/process running API routes, Socket.IO gateway, background schedulers, and the trade execution engine.
   * Best suited for development, small beta deployments (<300 traders), and staging environments.
2. **Horizontal Scale-Out Topology (`ROLE=api`, `ROLE=gateway`, `ROLE=engine`):**
   * **`ROLE=engine` (Strictly 1 Replica):** Owns the live in-memory `tradeIndex.ts`, MetaTrader 5 price ingestion (`priceFeed.ts`), SL/TP/Pending triggers (`tradeEngine.ts`), and fast PnL calculations.
   * **`ROLE=gateway` ($N$ Replicas):** Stateless Socket.IO nodes handling client WebSockets, session revalidation, room memberships, and client delta delivery. Subscribes to Redis channels `rt:price` and `rt:equity`.
   * **`ROLE=api` ($N$ Replicas):** Stateless Express HTTP nodes handling auth, orders, KYC, payouts, and admin operations. Publishes trade mutations to the engine via Redis channel `propfirm:trade-index:v1`.

### 1.4 Background Workers, Schedulers & Engines
All schedulers are registered in `backend/services/schedulerService.ts` and gated across instances using PostgreSQL session advisory locks (`utils/advisoryLock.ts`):

| Scheduler / Worker | File Location | Cadence (Event Mode) | Cadence (Interval Mode) | Advisory Lock Key | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SL/TP Monitor** | `tradeEngine.ts` | 5,000 ms (fallback) | 500 ms | `jobs:check_sltp` | Closes trades hitting SL/TP boundaries |
| **Pending Orders** | `tradeEngine.ts` | 5,000 ms (fallback) | 500 ms | `jobs:check_pending_orders` | Converts Limit/Stop orders to open positions |
| **Drawdown Monitor** | `tradeEngine.ts` | 10,000 ms (fallback)| 1,000 ms | `jobs:check_floating_drawdown` | Enforces trailing floor & daily loss limits |
| **Peak Equity Flush**| `tradeEngine.ts` | 1,000 ms | Disabled | In-process | Batches EOD peak equity updates to DB |
| **Trade Index Drift**| `tradeEngine.ts` | 30,000 ms | Disabled | In-process | Full DB-to-memory reconciliation |
| **Challenge Engine** | `challengeEngine.ts` | 30,000 ms | 30,000 ms | `jobs:challenge_engine` | Evaluates targets, scaling, and fraud rules |
| **Competition Engine**| `competitionEngine.ts`| 30,000 ms | 30,000 ms | `jobs:competition_engine`| Updates tournament leaderboards and states |
| **Referral Seasons** | `referralSeasonEngine.ts`| 30,000 ms | 30,000 ms | `jobs:referral_season_engine`| Processes affiliate season milestones |
| **Competition Bots** | `competitionBotTick.ts` | 60,000 ms | 60,000 ms | `jobs:competition_bot_tick` | Simulates bot leaderboard movement |
| **News Force-Close** | `newsForceClose.ts` | 10,000 ms | 10,000 ms | `jobs:news_force_close` | Closes positions before high-impact news |
| **Weekend Close** | `weekendForceClose.ts` | 60,000 ms | 60,000 ms | `jobs:weekend_force_close` | Forces flat positions before market close |
| **Flat-by-Close** | `flatByClose.ts` | 60,000 ms | 60,000 ms | `jobs:flat_by_close` | Daily futures-style account flattening |
| **Notifications** | `notificationQueue.ts` | 20,000 ms | 20,000 ms | `jobs:notification_delivery` | Delivers queued in-app notifications |
| **Account Linking** | `accountLinkingService.ts`| 15 mins | 15 mins | `jobs:account_linking` | Identifies multi-accounting / passing syndicates |
| **Idempotency Reap** | `idempotency.ts` | 60 mins | 60 mins | `jobs:idempotency_reap` | Cleans expired API idempotency claims |
| **Analytics Rollup** | `analytics/rollups.ts` | 10 mins | 10 mins | `jobs:analytics_rollups` | Refreshes cohort and admin intelligence rollups |
| **Payout SLA Watch** | `schedulerService.ts` | 60 mins | 60 mins | `jobs:payout_sla_watch` | Alerts ops when payout requests age past 24h |
| **Price Maintenance**| `priceFeed.ts` | 24h / 30m / 30s | 24h / 30m / 30s | In-process | Prunes old tick history; syncs hourly bars |
| **Dedicated Email Worker**| `workers/emailWorker.js` | 5,000 ms poll | 5,000 ms poll | Row-level locking | Processes `email_queue` batch deliveries |

### 1.5 External Services & Dependencies
* **Payment Processor:** Stripe API & Webhooks (`routes/billing.js`).
* **Transactional Email:** Nodemailer over SMTP (Brevo / SendGrid / Amazon SES / Postmark).
* **Application Monitoring:** Sentry (`@sentry/node`, `@sentry/profiling-node`, `@sentry/react`).
* **Market Data Feed:** MetaTrader 5 Terminal running the DWX Connect EA (local filesystem bridge).
* **Charting Widget:** TradingView public embed widget (`TradingViewWidget.jsx`).

---

## 2. RUNTIME REQUIREMENTS

### 2.1 Engine & Language Specifics
* **Node.js:** `24.19.0` (LTS active branch).
* **Package Manager:** `npm` (Lockfile version 3).
* **TypeScript Compilation:**
  * Root `tsconfig.json`: `target: "ES2022"`, `module: "commonjs"`, `moduleResolution: "node"`, `outDir: "dist"`.
  * Workspace packages: `@propfirm/contracts` (TypeScript types shared between backend and frontend).

### 2.2 Production Build & Start Commands
* **Backend Build:**
  ```bash
  cd backend && npm ci && npm run build
  ```
* **Backend Monolith Start:**
  ```bash
  NODE_ENV=production ROLE=all node dist/server.js
  ```
* **Backend Split-Role Starts:**
  ```bash
  # Engine Node (1 instance only)
  NODE_ENV=production ROLE=engine ENGINE_MODE=event node dist/server.js

  # Gateway Nodes (Scalable horizontally)
  NODE_ENV=production ROLE=gateway PORT=3001 node dist/server.js

  # Stateless API Nodes (Scalable horizontally)
  NODE_ENV=production ROLE=api PORT=3000 node dist/server.js

  # Standalone Email Worker
  NODE_ENV=production node dist/workers/emailWorker.js
  ```
* **Frontend Build & Serve:**
  ```bash
  cd frontend && npm ci && npm run build
  # Outputs static assets to frontend/dist/ (served via Nginx)
  ```

### 2.3 Required Environment Variables
| Variable | Required In | Description | Default / Example |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | All | Application environment | `production` |
| `PORT` | Backend | HTTP/WebSocket listening port | `3000` |
| `ROLE` | Backend | Process role (`all`, `engine`, `gateway`, `api`)| `all` |
| `ENGINE_MODE` | Backend | Execution model (`event` or `interval`) | `event` |
| `DATABASE_URL` | Backend | PostgreSQL connection string | `postgres://user:pass@host:5432/dbname` |
| `READ_DATABASE_URL` | Optional | Dedicated read replica connection | Defaults to `DATABASE_URL` |
| `DIRECT_DATABASE_URL`| Production | Direct Postgres bypass for PgBouncer advisory locks| Defaults to `DATABASE_URL` |
| `REDIS_URL` | Production | Redis instance connection string | `redis://localhost:6379` |
| `JWT_SECRET` | Backend | HMAC secret for trader JWTs | High-entropy string |
| `ADMIN_JWT_SECRET` | Backend | HMAC secret for admin session JWTs | High-entropy string |
| `KYC_FILE_ENCRYPTION_KEY`| Backend| AES-256-GCM disk encryption key for KYC | 64-char hex / 32-byte string |
| `DWX_PATH` / `MT5_BRIDGE_PATH`| Engine | Mount directory for MetaTrader 5 files | `/app/dwx` or `/mnt/mt5` |
| `PRICE_BROADCAST_MS` | Backend | Realtime price delta coalescing interval | `250` (ms) |
| `EQUITY_PUSH_INTERVAL_MS`| Backend| Realtime equity snapshot fanout interval | `500` (ms) |
| `STRIPE_WEBHOOK_SECRET` | Backend | Stripe webhook signing secret | `whsec_...` |
| `SMTP_HOST` / `PORT` / `USER` / `PASS`| Email Worker| Mail transport configuration | SMTP credentials |
| `FRONTEND_URL` | Backend | CORS and absolute URL origin | `https://trader.domain.com` |

### 2.4 Continuous Processes Required
1. **Engine Process:** 1 process continuously running to maintain the `tradeIndex` and watch the MT5 file bridge.
2. **PostgreSQL Database:** PostgreSQL 18 with persistent storage.
3. **Redis Server:** Redis 7.x for message bus and caching.
4. **MetaTrader 5 Terminal:** Dedicated Windows or Wine process running 24/7 with the DWX Connect EA attached to active market charts.
5. **Email Worker:** Background process continuously polling and delivering transactional emails.

---

## 3. PRICE-FEED ARCHITECTURE

### 3.1 DWX Connect Integration & Protocol
* **Connection Mechanism:** Local filesystem shared bridge (`backend/priceFeed.ts`).
* **Protocol:** File watching (`fs.watch`) + 1,000 ms interval polling fallback.
* **Bridge Files:**
  * `DWX_Market_Data.txt`: Written by the MetaTrader 5 DWX Connect EA containing comma-delimited quotes for all subscribed instruments.
  * `DWX_Commands_0.txt`: Written by Node to issue order execution/history commands to MT5 (if bridging active trades).
* **Upstream Network Connections:** **0**. The Node.js application does not create direct REST or WebSocket connections to external liquidity providers; all market quotes are ingested from the local MT5 file bridge.

```
┌────────────────────────────────────────────────────────┐
│   MetaTrader 5 Client Terminal (Windows / Wine)        │
│   └── DWX Connect EA (Attaches to Market Watch)        │
└──────────────────────────┬─────────────────────────────┘
                           │ (Writes every 50-250ms)
                           ▼
┌────────────────────────────────────────────────────────┐
│   Shared Volume: /app/dwx/DWX_Market_Data.txt          │
└──────────────────────────┬─────────────────────────────┘
                           │ (fs.watch + 1s polling)
                           ▼
┌────────────────────────────────────────────────────────┐
│   Node.js priceFeed.ts                                 │
│   ├── In-Memory Map (prices)                           │
│   ├── Throttled DB Upsert -> price_feed (every 3s)     │
│   └── Batched Insert -> price_feed_history             │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│   priceBroadcast.ts -> tradeEngine.onPriceTick()       │
│   └── realtimeFanout.ts -> Coalesces at 250ms delta    │
└──────────────────────────┬─────────────────────────────┘
                           │ (Pub/Sub on Redis 'rt:price')
                           ▼
┌────────────────────────────────────────────────────────┐
│   Socket.IO Gateway Nodes -> room 'prices' &           │
│                              rooms 'price:<symbol>'    │
└────────────────────────────────────────────────────────┘
```

### 3.2 Ingestion, Throttling & Storage Mechanics
* **Tick Processing Pipeline (`priceFeed.ts`, `priceBroadcast.ts`):**
  1. `readDWXFileSafe()` reads and parses the JSON/text matrix from disk.
  2. Parses instruments, validates positive spread, and updates internal in-memory object `prices`.
  3. Detects price movements per symbol and appends them to a batched SQL query for `price_feed_history`.
  4. Upserts current rates into the `price_feed` table on a 3-second throttle to minimize DB write contention.
  5. Syncs hourly rollups into `price_feed_history_1h` every 15 seconds.
  6. Dispatches tick to `tradeEngine.onPriceTick(instrument, bid, ask)` and `realtimeFanout.queuePriceDelta()`.

### 3.3 Client Broadcast & Socket.IO Fan-Out
* **Broadcast Cadence:** Throttled to `PRICE_BROADCAST_MS=250` (4 updates/sec maximum).
* **Delta Optimization:**
  * The server broadcasts **delta payloads** containing only symbols that moved during the 250ms window (`{ t: timestamp, p: { EURUSD: { bid, ask, spread } } }`).
  * Payload size is reduced from ~6 KB (full 45-symbol matrix) to ~120–350 bytes per tick.
* **Room Architecture:**
  * `prices`: Default room receiving all coalesced market deltas.
  * `price:<symbol>`: Granular per-symbol rooms. Clients calling `socket.emit('subscribe_instruments', ['EURUSD', 'BTCUSD'])` are moved to specific rooms, saving up to 90% bandwidth on mobile/focused views.
* **Database I/O per Tick:**
  * **Reads:** 0 reads against the database on the hot path (all evaluations use in-memory prices and indexes).
  * **Writes:** Batched inserts to `price_feed_history` (1 query containing multiple rows every 250–1000ms).

---

## 4. TRADING ENGINE

### 4.1 In-Memory Execution Architecture (`tradeIndex.ts`, `tradeEngine.ts`)
The trading engine maintains an in-memory index of all open positions and pending orders grouped by instrument:
* `openTradesByInstrument`: `Map<string, Map<string, TradeEntry>>`
* `pendingOrdersByInstrument`: `Map<string, Map<string, TradeEntry>>`
* `accountIndex`: `Map<string, AccountEntry>`

When a price tick arrives for an instrument, the engine iterates **only** over the trades open for that specific instrument in native memory without querying PostgreSQL.

### 4.2 Trade Lifecycle Flows

#### 1. Open Trade Flow (`POST /trades/open`)
1. **Idempotency & Circuit Breakers:** Checks `Idempotency-Key` header and feed health circuit breaker (`feedHealth.ts`).
2. **Validation:** Zod validation on lot size, instrument code, order type, SL/TP bounds, max risk per trade, and daily lot limits.
3. **Database Transaction (`BEGIN`):**
   * Acquires row lock: `SELECT * FROM accounts WHERE id = $1 FOR UPDATE`.
   * Verifies account status (`active`), balance, and required margin.
   * Inserts row into `trades` table (`status='open'`, `open_price`, `open_time=NOW()`).
   * Commits transaction (`COMMIT`).
4. **Index Sync:** Updates local `tradeIndex` (in Monolith/Engine) or publishes mutation to Redis channel `propfirm:trade-index:v1` (from API node).
5. **Realtime Notification:** Emits `trade_opened` to the user's Socket.IO room.

#### 2. Close Trade Flow (`POST /trades/close` / SL / TP / Liquidations)
1. **Price Resolution:** Fetches latest executable bid/ask from in-memory cache.
2. **PnL Computation:** Calculates gross PnL, pip distance, commission, and FX conversion rates via `calculatePnL()` and `decimal.js`.
3. **Database Transaction (`BEGIN`):**
   * Acquires row locks: `SELECT * FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED` and `SELECT * FROM accounts WHERE id = $2 FOR UPDATE`.
   * Updates `trades` table (`status='closed'`, `close_price`, `close_time=NOW()`, `demo_pnl`, `close_reason`).
   * Updates `accounts` table (`current_balance = current_balance + pnl`, `peak_balance = GREATEST(peak_balance, current_balance)`).
   * Increments B-Book performance metrics in `bbook_pnl`.
   * Commits transaction (`COMMIT`).
4. **Index Sync:** Removes trade from in-memory index; applies balance mutation.
5. **Realtime Notification:** Emits `trade_closed` event with realized P&L to user socket.

#### 3. Pending Order Execution Flow
1. Pending orders (`limit`, `stop`) are indexed by instrument in `pendingOrdersByInstrument`.
2. On every price tick, `tradeEngine.onPriceTick` compares current price against target trigger prices.
3. When triggered:
   * Acquires DB lock (`FOR UPDATE SKIP LOCKED`).
   * Converts trade from `pending` to `open` at the trigger price (incorporating slippage).
   * Updates in-memory index and dispatches `pending_order_filled` / `trade_opened` socket events.

#### 4. SL/TP Execution & Slippage Modeling (`slippageModel.ts`)
* Evaluated on every price tick in `tradeEngine.ts`.
* Computes realistic market slippage based on instrument volatility, position size, and order direction.
* Uses `FOR UPDATE SKIP LOCKED` inside a transaction to prevent duplicate closing if multiple tick workers or API close requests overlap.
* Emits `sl_triggered` or `tp_triggered` socket events with calculated slippage in pips.

#### 5. Floating Drawdown & Live Equity Fan-Out
* **Fast PnL Path (`fastPnL.ts`):** Evaluates open positions in nanoseconds using native IEEE-754 floats with pre-resolved FX rates and contract multipliers.
* **Equity Calculation:**
  $$\text{Equity} = \text{Current Balance} + \sum \text{Floating PnL}$$
* **Threshold Detection:** If floating equity breaches the EOD trailing drawdown floor or daily loss limit, the engine escalates to `Decimal.js` confirmation and initiates immediate liquidation (`autoCloseAndFail`).
* **Coalesced Push:** Live equity updates are buffered and published to Redis channel `rt:equity` every `EQUITY_PUSH_INTERVAL_MS=500`.

---

## 5. CHALLENGE & RISK ENGINE

### 5.1 Architecture & Evaluation Cadence (`challengeEngine.ts`)
* **Cadence:** Evaluates every 30 seconds via `schedulerService.ts`.
* **Concurrency:** Runs with bounded worker concurrency (`ENGINE_SWEEP_CONCURRENCY=8`) to prevent connection pool starvation.
* **Target Accounts:** All active accounts with `account_type IN ('phase1', 'phase2', 'phase3', 'funded')`.

### 5.2 Rules Evaluated
1. **Time Limits / Expiry:** Checks if `NOW() > phase_end_date` on challenge phases (funded accounts have no time limit). Force-closes open positions and sets status to `expired`.
2. **Inactivity Auto-Fail:** Fails accounts with 0 trade activity for $>30$ days (`inactivity_fail_days`).
3. **Trailing Drawdown Floor:**
   * Dynamic High-Water Mark (EOD Trailing): Drawdown floor trails highest recorded end-of-day equity.
   * Lock at Starting Balance: If configured (`funded_drawdown_locks_at_pct`), floor locks at original balance once profit reaches a threshold.
4. **Daily Drawdown Limit:** Compares today's realized + floating losses against `daily_drawdown_pct`.
5. **Profit Target & Passing:**
   * Triggers when $\text{Realized Balance} - \text{Starting Balance} \ge \text{Profit Target}$ AND open trades $= 0$.
   * **Promotion Review Queue:** Passed accounts are marked `passed` and a review row is created in `account_promotion_reviews` for admin one-click approval (preventing unauthorized auto-minting of funded accounts).
6. **Trading Days Rule:** Requires a minimum number of qualifying trading days (days finishing with $\ge 0.5\%$ profit).
7. **Consistency Rule:** Soft-holds accounts if any single day accounts for $> \text{consistency\_max\_day\_pct}$ (e.g. 50%) of total profit.
8. **Scaling Plan (Funded Accounts):**
   * Injects real capital increments (`applyBalanceAdjustment`) and doubles risk multiplier (`scaling_multiplier`) at every milestone (e.g. 10% net profit).
9. **Abuse & Fraud Detection:**
   * `detectRapidOpposingTrades`: Flags rapid buy/sell cycles on the same symbol within 5 minutes.
   * `detectOpposingTrades`: Detects and auto-locks accounts executing cross-account hedging across multiple IDs.
   * `accountLinkingService`: Evaluates IP, browser fingerprint, device ID, KYC name, and payment method collisions.

---

## 6. DATABASE (POSTGRESQL)

### 6.1 Version & Core Schema
* **Database Engine:** PostgreSQL 18 (`postgres:18-alpine`).
* **Primary Tables (74 total in `000_core_schema.sql`):**
  * `users`, `accounts`, `trades`, `price_feed`, `price_feed_history`, `price_feed_history_1h`.
  * `challenge_orders`, `challenge_checkout_sessions`, `challenge_payments`, `payouts`, `balance_adjustments`.
  * `account_promotion_reviews`, `email_queue`, `stripe_events`, `idempotency_claims`, `platform_settings`.
  * `account_link_clusters`, `account_link_evidence`, `admin_immutable_audit`, `bbook_pnl`.

### 6.2 Connection Pool Sizing & Architecture (`db.ts`)
The platform implements a **three-pool architecture** to isolate hot trading traffic from analytics and session locks:

```
                               ┌─────────────────────────┐
                               │     Node.js Process     │
                               └────────────┬────────────┘
                                            │
                ┌───────────────────────────┼───────────────────────────┐
                │                           │                           │
                ▼                           ▼                           ▼
      ┌───────────────────┐       ┌───────────────────┐       ┌───────────────────┐
      │   Primary Pool    │       │     Read Pool     │       │    Direct Pool    │
      │ (max: 60 / gtw:10)│       │     (max: 20)     │       │     (max: 20)     │
      │ Timeout: 30s      │       │ Timeout: 60s      │       │ No Stmt Timeout   │
      └─────────┬─────────┘       └─────────┬─────────┘       └─────────┬─────────┘
                │                           │                           │
                │ (CRUD, Trades, Orders)    │ (Analytics, Public Stats) │ (Advisory Locks)
                ▼                           ▼                           │
      ┌───────────────────────────────────────────────┐                 │
      │             PgBouncer Pooler                  │                 │
      │         (Transaction Mode :6432)              │                 │
      └───────────────────────┬───────────────────────┘                 │
                              │                                         │
                              ▼                                         ▼
      ┌───────────────────────────────────────────────────────────────────────────┐
      │                         PostgreSQL 18 Primary Server                      │
      └───────────────────────────────────────────────────────────────────────────┘
```

1. **`pool` (Primary Write Pool):**
   * Sizing: Default `60` connections (`10` on Gateway instances).
   * `connectionTimeoutMillis: 5000`, `statement_timeout: 30000`.
   * Handles all transactional operations, trade placement, and challenge evaluations.
2. **`readPool` (Read Replica Pool):**
   * Sizing: Default `20` connections.
   * `statement_timeout: 60000`.
   * Targets `READ_DATABASE_URL` (falls back to primary). Used for leaderboard queries, admin intelligence rollups, and audit exports.
3. **`directPool` (Direct Pool for Session Advisory Locks):**
   * Sizing: Default `20` connections.
   * Targets `DIRECT_DATABASE_URL` (bypasses PgBouncer).
   * **Why required:** In PgBouncer transaction pooling mode, session-level advisory locks (`pg_try_advisory_lock`) would leak across pooled connections. `directPool` connects directly to Postgres to guarantee safe session locking for schedulers.

### 6.3 PgBouncer Configuration (`docker-compose.yml`)
* **Image:** `edoburu/pgbouncer:1.22.0`.
* **Pool Mode:** `transaction`.
* **Capacity:** `max_client_conn = 500`, `default_pool_size = 40`, `reserve_pool_size = 10`.

---

## 7. REDIS INFRASTRUCTURE

### 7.1 Role & Requirement Status
* **Single-Instance Monolith (`ROLE=all`):** Optional (the app falls back gracefully to in-process memory stores if Redis is unavailable).
* **Distributed Scale-Out (`ROLE=api/gateway/engine`):** **MANDATORY**. Required for pub/sub messaging, Socket.IO multi-node clustering, and distributed rate limiting.

### 7.2 Key Patterns & Channels
| Namespace / Key | Type | TTL | Purpose |
| :--- | :--- | :--- | :--- |
| `token_version:{userId}` | String | 300 s (5 min) | Fast auth validation without hitting PostgreSQL |
| `banned_status:{userId}` | String | 300 s (5 min) | Cached user suspension status |
| `rl:{limiter}:{key}` | String / Counter | Window-based | Distributed rate limiting via `rate-limit-redis` |
| `rt:price` | Pub/Sub Channel | Live stream | Delivers coalesced price deltas from Engine $\rightarrow$ Gateways |
| `rt:equity` | Pub/Sub Channel | Live stream | Delivers live equity snapshots from Engine $\rightarrow$ Gateways |
| `propfirm:trade-index:v1`| Pub/Sub Channel| Live stream | Sends HTTP trade mutations from API nodes $\rightarrow$ Engine |

---

## 8. KAFKA & QUEUES

### 8.1 Kafka Status
* **Package:** `kafkajs: 2.2.4` installed.
* **Status:** **Disabled by default** (`KAFKA_ENABLED=false`).
* **Usage in Code:** Kafka is used strictly for optional audit/domain event streaming (`publishDomainEvent` in `backend/routes/chat.js`). If Kafka is disabled or fails to connect, the application logs a warning and operates normally without breaking any core trading or challenge functionality.

### 8.2 Production Queuing System
The application uses PostgreSQL as an ACID transactional queue:
* **Email Queue (`email_queue` table):**
  * Handled by `workers/emailWorker.js`.
  * Claims batches using `FOR UPDATE SKIP LOCKED`.
  * Implements exponential backoff, retry limits, and failure logging.
* **Notification Queue (`admin_notifications` table):**
  * Polled every 20s by `schedulerService.ts`.

---

## 9. SOCKET.IO REALTIME INFRASTRUCTURE

### 9.1 Configuration & Transports
* **Version:** Socket.IO `4.8.1`.
* **Transports:** `['websocket', 'polling']` (WebSocket prioritized with automatic HTTP long-polling fallback).
* **Heartbeat Settings:** `pingInterval: 20000ms`, `pingTimeout: 15000ms`.
* **Buffer Limit:** `maxHttpBufferSize: 16384` (16 KB).
* **Clustering Adapter:** `@socket.io/redis-adapter` for multi-node gateway broadcasting.

### 9.2 Authentication & Periodic Revalidation (`socketService.ts`)
* **Handshake Authentication:** Validates JWT from cookie (`token` / `admin_token`) or handshake auth payload; verifies `token_version` and `is_banned` against PostgreSQL.
* **Periodic Revalidation (`SESSION_REVALIDATE_MS=300000`):**
  * Every 5 minutes, each active WebSocket connection independently re-verifies session validity against PostgreSQL.
  * Ensures banned traders or invalidated tokens are disconnected within 5 minutes without relying on client reconnection.
  * Jittered initial execution prevents connection stampedes on restart.

### 9.3 Room Subscriptions
* `user:<userId>`: Individual user room for balance, execution, and KYC alerts.
* `admin`: Platform admin room for dispute alerts, four-eyes requests, and risk breaches.
* `prices`: Broadcasts all 45 instrument deltas.
* `price:<symbol>`: Granular single-instrument room (e.g. `price:EURUSD`).
* `chat:<conversationId>`: Multi-tenant support chat channel.

---

## 10. FRONTEND REALTIME BEHAVIOR

### 10.1 State Management & Delta Merging (`useDashboardSocket.js`, `useStore.js`)
* **Zustand Store:** Holds global prices, open positions, live equity, and account state.
* **Delta Merging:** When `{ p: { EURUSD: {...} } }` arrives, `useDashboardSocket.js` merges the incoming keys into the existing price dictionary without re-instantiating unaffected symbols.
* **Animation Frame Coalescing:**
  ```javascript
  // Coalesces rapid equity updates to match screen refresh rate (60Hz / 120Hz)
  socket.on('equity_update', (data) => {
    pendingEquityRef.current.set(data.account_id, data)
    if (equityFrameRef.current) return
    equityFrameRef.current = requestAnimationFrame(() => {
      equityFrameRef.current = null
      for (const [accountId, snapshot] of pendingEquityRef.current) {
        updateLiveEquity(accountId, snapshot)
      }
      pendingEquityRef.current.clear()
    })
  })
  ```
* **TradingView Chart Widget:** Rendered in an isolated container (`TradingViewWidget.jsx`) communicating directly with TradingView's market data servers, decoupling candlestick rendering from the main React component tree.

---

## 11. STORAGE & FILE UPLOADS

### 11.1 Local Disk Storage & Encryption (`secureKycStorage.js`)
* **Upload Path:** `/app/uploads` (mounted locally or via Docker volume).
  * KYC Documents: `uploads/kyc/`
  * Trade Screenshots: `uploads/trades/screenshots/`
  * Avatars: `uploads/`
* **Encryption at Rest:**
  * KYC identity documents are encrypted using **AES-256-GCM** before writing to disk.
  * File format: `KYCENC1\0` header + 12-byte IV + 16-byte Auth Tag + Ciphertext.
  * Encrypted files receive the `.enc` extension; plaintexts are unlinked immediately.
  * Decryption occurs in-memory on demand when an authorized admin views the document.
* **Object Storage (S3 / Cloudflare R2):** Not currently implemented in code. Migration to S3/R2 requires updating `backend/utils/secureKycStorage.js` and `backend/routes/kyc.js`.

---

## 12. PAYMENTS, EMAIL & THIRD-PARTY APIS

### 12.1 Payments & Webhooks (`routes/billing.js`)
* **Integration:** Stripe Checkout Sessions & Webhook Handlers.
* **Supported Events:**
  * `checkout.session.completed`: Sets order to `paid`, creates challenge account, computes affiliate commissions.
  * `charge.refunded`: Marks order `refunded`, locks associated trading accounts, claws back affiliate commissions.
  * `charge.dispute.created`: Marks order `disputed`, freezes trading accounts.
  * `checkout.session.expired` / `async_payment_failed`: Cancels abandoned orders.
* **Security & Replay Protection:**
  * Webhook signatures verified via HMAC-SHA256 with 5-minute replay tolerance window (`STRIPE_WEBHOOK_TOLERANCE_SECONDS=300`).
  * Webhook idempotency enforced via PostgreSQL table `stripe_events` inside the transaction.

### 12.2 Transactional Email (`emailWorker.js`, `emailQueue.js`)
* **Transport:** Nodemailer over SMTP.
* **Templates:** Phase passed, account failed, account expired, KYC approved/rejected, payout requested/approved, affiliate commission earned, password reset.
* **Architecture:** Asynchronous DB queue with batch claiming (`FOR UPDATE SKIP LOCKED`) and automatic retries.

---

## 13. CURRENT DEPLOYMENT READINESS

### 13.1 Containerization
* **`backend/Dockerfile`:**
  * Multi-stage build based on `node:24.19.0-alpine3.21`.
  * Builds TypeScript source and discards `devDependencies` in the final release image.
* **`frontend/Dockerfile`:**
  * Multi-stage build based on `node:24.19.0-alpine3.21` and `nginx:1.27-alpine`.
  * Generates static bundle via `npm run build` and serves via Alpine Nginx.
* **`docker-compose.yml` Profiles:**
  * `monolith`: Single backend container, Postgres, Redis, Nginx.
  * `scaleout`: Split roles (`engine`, `gateway` x2, `api` x2, `email-worker`, Postgres, Redis, Nginx).
  * `pgbouncer`: Inserts PgBouncer between application and Postgres.
  * `monitoring`: Provisions Prometheus and Grafana.

### 13.2 Nginx Reverse Proxy (`deploy/nginx/`)
* Pre-configured reverse proxy handling:
  * WebSocket upgrade headers (`Upgrade $http_upgrade`, `Connection "upgrade"`).
  * Rate limiting zones (`limit_req_zone` for API and Auth endpoints).
  * Security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options).
  * Upstream load balancing for `api` and `gateway` clusters with `ip_hash` session pinning.

### 13.3 Migrations & Health Probes
* **Automatic Migrations:** `scripts/run-migrations.js` runs on backend startup, executing all unapplied SQL migrations in `backend/migrations/` sequentially.
* **Health Endpoints:**
  * `GET /health`: Liveness probe (returns status 200).
  * `GET /health/detailed`: Readiness probe (validates PostgreSQL, Redis, and MetaTrader 5 price feed freshness).
  * `GET /metrics`: Prometheus metrics exporter.

---

## 14. CAPACITY TARGET EVALUATION

### 14.1 Capacity Profile
* **Target Load:** 2,000 connected WebSockets / 1,000 active concurrent traders / 20,000 open positions.
* **Stress Peak:** 2,000 active concurrent traders / 40,000 open positions.

### 14.2 Bottleneck Analysis

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             BOTTLENECK HEATMAP                              │
├──────────────────────┬────────────────────────┬─────────────────────────────┤
│ Subsystem            │ Bottleneck Likelihood  │ Primary Resource Constraint │
├──────────────────────┼────────────────────────┼─────────────────────────────┤
│ 1. Engine CPU (Tick) │ MEDIUM-HIGH            │ Single-thread Node.js CPU   │
│ 2. Gateway WebSockets│ LOW-MEDIUM             │ Bandwidth & Socket Memory   │
│ 3. Database Write I/O│ MEDIUM                 │ Disk IOPS (Tick History)    │
│ 4. Challenge Sweeps  │ LOW                    │ DB Connection Pool Limit    │
│ 5. Memory Footprint  │ VERY LOW               │ RAM (Trade Index < 150 MB)  │
└──────────────────────┴────────────────────────┴─────────────────────────────┘
```

1. **Engine Single-Thread CPU (Tick Evaluation Loop):**
   * Under 40,000 open positions across 45 instruments, an average of $\sim 888$ positions exist per instrument.
   * On a price tick for EURUSD, the engine iterates over 888 positions. Using native floats (`fastPnL.ts`), iterating 888 items takes $\sim 0.08 - 0.15\text{ ms}$.
   * At 40 ticks/sec across all instruments, total CPU execution time on the hot path is $<10\text{ ms/sec}$ ($<1\%$ CPU load for calculation).
   * **The Real Bottleneck:** Single-thread latency will be dominated by JSON serialization and Redis publish operations if full snapshots are published. The 250ms coalesced delta and 500ms equity push ensure the engine stays under 25% CPU core utilization.
2. **Socket.IO Realtime Bandwidth:**
   * 2,000 connected clients receiving 250ms deltas ($\sim 250$ bytes per payload, 4 times/sec) consume:
     $$2000 \times 250\text{ bytes} \times 4\text{ updates/sec} = 2.0\text{ MB/sec} = 16\text{ Mbps}$$
   * Easily handled by 1 Gbps network interfaces on modern cloud VMs.
3. **Database Write IOPS (Tick History):**
   * If 45 symbols tick 2 times/sec, batched inserts produce $\sim 90\text{ rows/sec}$ into `price_feed_history`.
   * Standard SSDs handle this with $<250\text{ IOPS}$. Table partitioning and the existing `pruneOldPriceHistory` maintenance job prevent unbounded table bloat.
4. **Challenge Engine Sweeps:**
   * Scanning 2,000 active accounts every 30 seconds with 8 workers evaluates $\sim 250\text{ accounts/worker}$.
   * Each check takes $\sim 2 - 5\text{ ms}$, completing the full sweep in $<2\text{ seconds}$ without queuing the write pool.

---

## 15. HOSTING REQUIREMENTS & SIZING

### 15.1 Development / Staging Setup
* **Topology:** Single VM running Docker Compose (`monolith` profile).
* **Specs:** 4 vCPU, 8 GB RAM, 50 GB NVMe SSD.
* **Components:** Backend (`ROLE=all`), Frontend, PostgreSQL 18, Redis 7, Wine/MT5.

### 15.2 Small Beta Setup (Up to 300 Traders / 5,000 Open Positions)
| Service | Quantity | Recommended Specs | Minimum RAM | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **App Server** | 1 | 4 vCPU (Compute Optimized) | 8 GB | Monolith (`ROLE=all`) + Email Worker |
| **Database** | 1 | 2 vCPU / Managed PostgreSQL | 4 GB | Primary DB + PgBouncer |
| **Redis** | 1 | 1 vCPU / Managed Redis 7 | 1 GB | Cache & Rate Limiting |
| **MT5 Terminal** | 1 | 2 vCPU (Windows Server VM) | 4 GB | MT5 Terminal with DWX Connect EA |

### 15.3 Target Production Setup (1,000–2,000 Active Traders / 40,000 Open Positions)
```
                               ┌────────────────────────────────┐
                               │  Cloudflare WAF / CDN / SSL    │
                               └───────────────┬────────────────┘
                                               │
                                               ▼
                               ┌────────────────────────────────┐
                               │  2x Nginx Load Balancers       │
                               │  (2 vCPU, 4 GB RAM each)       │
                               └───────────────┬────────────────┘
                                               │
               ┌───────────────────────────────┼───────────────────────────────┐
               │                               │                               │
               ▼                               ▼                               ▼
 ┌───────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
 │ 2x Stateless API Nodes    │   │ 2x Socket Gateway Nodes   │   │ 1x Dedicated Engine Node  │
 │ (2 vCPU, 4 GB RAM each)   │   │ (4 vCPU, 8 GB RAM each)   │   │ (4 vCPU, 8 GB RAM Compute)│
 └─────────────┬─────────────┘   └─────────────┬─────────────┘   └─────────────┬─────────────┘
               │                               │                               │
               └───────────────────────────────┼───────────────────────────────┘
                                               │
                                               ▼
                               ┌────────────────────────────────┐
                               │  Managed Redis 7 (Cluster)     │
                               │  (2 vCPU, 4 GB RAM)            │
                               └───────────────┬────────────────┘
                                               │
                                               ▼
                               ┌────────────────────────────────┐
                               │  Managed PostgreSQL 18         │
                               │  (4-8 vCPU, 16-32 GB RAM,      │
                               │   PgBouncer, 1000+ IOPS SSD)   │
                               └────────────────────────────────┘
```

* **Trading Engine Node:** 1x Dedicated 4 vCPU (Compute Optimized, high single-core frequency), 8 GB RAM.
* **Socket.IO Gateway Nodes:** 2x 4 vCPU, 8 GB RAM (Load balanced with sticky IP hashing).
* **Stateless API Nodes:** 2x 2 vCPU, 4 GB RAM.
* **Email & Analytics Worker:** 1x 2 vCPU, 4 GB RAM.
* **Managed PostgreSQL 18:** 4–8 vCPU, 16–32 GB RAM, Provisioned NVMe SSD (1,500+ IOPS), PgBouncer enabled.
* **Managed Redis 7:** 2 vCPU, 4 GB RAM (High availability replica recommended).
* **Windows Server VM (MT5 Terminal):** 1x 4 vCPU, 8 GB RAM (Runs MT5 Terminal 24/7 in an Equinix/London/New York financial data center for low latency to broker trade servers).

---

## 16. FREE-CREDIT & CLOUD SUITABILITY

### 16.1 Cloud Startup Credit Programs
* **AWS Activate:** $\$10,000 - \$100,000$ in credits.
* **Google Cloud for Startups:** $\$2,000 - \$350,000$ in credits.
* **Microsoft for Startups (Azure):** $\$5,000 - \$150,000$ in credits.
* **DigitalOcean / Hetzner / Vultr:** Ideal for cost-effective Windows MT5 instances and low-latency bare-metal VMs.

### 16.2 Component Compatibility Matrix
| Platform Component | Serverless (Lambda / Cloud Run) | Managed Container (ECS / GKE / AKS) | Dedicated VM (EC2 / Compute Engine) | Free-Tier / Credit Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Trading Engine (`ROLE=engine`)**| ❌ **INCOMPATIBLE** | ✅ **Supported** (1 replica) | ✅ **RECOMMENDED** | Must run continuously; requires in-memory state and local MT5 bridge. |
| **Socket Gateway (`ROLE=gateway`)**| ❌ **INCOMPATIBLE** | ✅ **Supported** | ✅ **RECOMMENDED** | Requires long-lived WebSockets; serverless request timeouts kill connections. |
| **Stateless API (`ROLE=api`)** | ⚠️ Possible (with cold starts)| ✅ **RECOMMENDED** | ✅ **Supported** | Can run on container platforms (ECS, Cloud Run with min-instances=1). |
| **PostgreSQL Database** | ⚠️ Neon / Supabase (with caveats)| ❌ Avoid Self-Hosted in K8s | ✅ **RECOMMENDED** (RDS/Cloud SQL)| Use RDS / Cloud SQL covered by startup credits. |
| **Redis Cache / Bus** | ⚠️ Upstash (Pub/Sub limits) | ✅ **Supported** | ✅ **RECOMMENDED** (ElastiCache/MemoryStore)| High-volume pub/sub is cheaper on managed VM Redis than per-command serverless. |
| **MetaTrader 5 Bridge** | ❌ **INCOMPATIBLE** | ⚠️ Wine in Docker (Complex) | ✅ **MANDATORY** (Windows VM) | Must be a dedicated Windows VM with GUI for the MT5 terminal. |

---

## 17. INFORMATION STILL NEEDED (GAPS & QUESTIONS)

To finalize exact infrastructure provisioning scripts (Terraform/Helm), the external architect/team should clarify the following operational details:

1. **MetaTrader 5 Hosting & Bridge Topology:**
   * Will the MetaTrader 5 terminal run on a dedicated Windows Cloud VPS (e.g. AWS EC2 Windows / Hetzner Windows), or will it run under Wine inside a Linux container?
   * If on a separate Windows VM, what shared filesystem protocol will bridge `DWX_Market_Data.txt` (NFS, SMB/Samba, or a lightweight TCP bridge daemon)?
2. **Broker / Feed Provider Characteristics:**
   * Which broker/server is the MT5 terminal connected to, and what is the physical location/region of the broker's trade server (e.g. LD4 London, NY4 New York, TY3 Tokyo)?
   * Siting the Engine and MT5 VM in the same data center region is necessary to minimize tick latency.
3. **Cloud Storage Migration (KYC & Screenshots):**
   * Is migration to AWS S3 or Cloudflare R2 required for KYC files and trade screenshots, or is a persistent multi-attach block volume (EFS / Managed Disk) preferred?
4. **Domain & SSL Ingress:**
   * Is Cloudflare or AWS CloudFront designated as the primary edge DNS / WAF proxy for SSL termination and DDoS mitigation?
5. **Peak Order Concurrency Expectations:**
   * What is the anticipated peak order placement burst rate during high-impact macroeconomic news releases (e.g. US NFP / FOMC interest rate announcements)?
