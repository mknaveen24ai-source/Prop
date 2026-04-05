# Prop Firm Platform: Comprehensive Project Handoff Documentation

> [!IMPORTANT]
> This document is the **Single Source of Truth** for the entire Prop Firm Trading Platform. It is designed to give a new AI assistant or developer 100% context on the architecture, logic, and state of the project as of **April 5, 2026**.

---

## SECTION 1 — PROJECT OVERVIEW

### 1.1 Platform Description
A high-frequency, institutional-grade prop firm trading platform built for retail traders. It allows users to purchase "challenges" (simulated trading accounts), pass specific performance milestones (Phase 1 and Phase 2), and eventually manage a "Funded" account where they can earned real payouts from their trading gains.

### 1.2 Business Model & Money Flow
- **Revenue In**: Traders purchase challenge accounts (e.g., $100 for a $10k account).
- **Revenue Out**: Successful funded traders receive payouts (e.g., 80/20 profit split).
- **The B-Book Model**: The platform operates as a "B-Book" broker. Trades are simulated locally against a real-time MT5 price feed. The platform profits when traders fail challenges (the majority) and pays out from its own reserves when funded traders profit. 
- **The A-Book (Planned)**: Future expansion involves "A-Booking" highly profitable traders by copying their trades to a real broker via the MT5 bridge.

### 1.3 User Journey
1. **Registration**: User signs up, passes device fingerprinting and country checks.
2. **Account Purchase**: User buys a challenge (Phase 1).
3. **Execution**: Trader opens/closes positions on a customized dashboard using real-time Forex/Commodity data.
4. **Phase 1 Pass**: Trader hits a profit target (e.g. 10%) without breaching drawdown limits (e.g. 10% trailing).
5. **Phase 2 Pass**: Trader hits a secondary target (e.g. 5%) with tighter rules.
6. **Funded**: Trader receives a "Funded" account. Payouts are requested via the dashboard and approved by admins.

### 1.4 Admin Journey
- **Risk Management**: Admins monitor "Hedge Exposure" (net lots across all users) to detect system-wide risk.
- **Fraud Detection**: Admins review "Opposing Trades" (hedging between two accounts to game the system) and "IP Multi-Accounts."
- **Manual Oversight**: Admins approve payouts, verify KYC documents, and can lock/disable accounts or force-close trades.

### 1.5 Current Project State
- **Backend Core**: 95% Complete. All engines (Trade, Challenge, Price, Progression) are fully operational.
- **Admin Portal**: 100% Rebuilt (Phase 1). Modular architecture is live; secondary features like "Four-Eyes" and "Immutable Audit" are implemented in the code but need UI Polish.
- **Trader UI**: 90% Complete. New "Masterpiece" design system (Glassmorphism) is applied to Login, Register, Home, and Dashboard. Trading Panel needs final CSS alignment.

---

## SECTION 2 — COMPLETE FOLDER & FILE STRUCTURE

### Backend Architecture (`/backend`)
- **`server.js`**: The primary entry point. Initializes Express, Socket.io, primary database tables, and security middlewares. It handles the server's heartbeat and global error handling.
- **`challengeEngine.js`**: The "heartbeat" of the platform. Runs every 30 seconds to evaluate all active accounts for expiry, drawdown breaches, profit targets, and fraud patterns (Opposing trades, IP detection).
- **`priceFeed.js`**: Deep integration with MT5 via `dwxconnect`. Watches a local text file for real-time price updates (Bid/Ask), saves them to PostgreSQL, and broadcasts them to all connected clients.
- **`constants.js`**: Central repository for contract sizes (e.g., EURUSD=100k, XAUUSD=100), leverage limits (Forex=1:30, Gold=1:10), and status enums.
- **`db.js`**: Clean PostgreSQL connection pool configuration using the `pg` library.
- **`mailer.js`**: Email dispatcher using Nodemailer (SendGrid). Contains templates for Account Passed, Account Failed, KYC status, and Payout updates.
- **`routes/trades.js`**: Large (2MB+) file managing the Trade Execution Engine. Handles opening positions, margin calculations, SL/TP checks (500ms loop), and floating PnL math.
- **`routes/admin.js`**: Monolithic management API (141KB). Handles overall stats, KYC verification, payout approval, and the "Four-Eyes" approval system.
- **`routes/auth.js`**: Comprehensive auth system. Manages 2FA (TOTP) setup/validation, login IP logging, device fingerprinting, and session management.
- **`services/progressionService.js`**: Logic for "promoting" accounts. Atomically handles Phase 1 -> Phase 2 and Phase 2 -> Funded transitions.
- **`utils/totp.js`**: Hand-written TOTP implementation (using `speakeasy`). Handles secret encryption at rest using AES-256-CBC.
- **`utils/logger.js`**: Winston-based logging. Records everything to both files (`/logs`) and the console with structured JSON metadata.

### Frontend Architecture (`/frontend`)
- **`src/App.js`**: Root component managing React Router 7 and global authentication state. Includes a global Axios interceptor for automated session expiry.
- **`/src/pages/admin/`**: Modularized Admin Portal. Each component (AdminUsers, AdminTrades, etc.) is a focused page that inherits layout from `AdminLayout.js`.
- **`/src/pages/Dashboard.js`**: The main shell for the trader experience. Contains the Sidebar, Topbar, and dynamic routing for the trader tools.
- **`/src/pages/DashboardHome.js`**: The trader's main view. Showcases account selection, active stats, and progress bars towards the next phase.
- **`/src/components/`**: Reusable UI components. Includes the `ThemeToggle`, `StatsGrid`, and various Chart wrappers.

---

## SECTION 3 — TECHNOLOGY STACK

### Backend
- **Node.js + Express 5**: Modern Express with built-in promise support (no more `try-catch` wrappers).
- **PostgreSQL**: Primary relational storage.
- **Socket.io 4.8**: Low-latency bid/ask updates and real-time account status alerts.
- **JWT (Json Web Tokens)**: Stateless authentication with `token_version` tracking for global session revocation.
- **Decimal.js**: Used for all financial calculations (PnL, Margin, Lot Sizes) to prevent floating-point errors.
- **Bcrypt**: Password hashing with cost factor 12.
- **Nodemailer**: Transactional emails for critical account events.

### Frontend
- **React 19**: Latest React features (Using `react-scripts` 5.0).
- **Vanilla CSS**: 100% custom design system. **No Tailwind / No Bootstrap**. Uses CSS Variables for global theme tokens.
- **React Router 7**: Modern routing with data-loading capabilities.
- **Recharts**: For dashboard visualizations (PnL curves, lot distribution).
- **Lightweight Charts**: The institutional standard for high-performance price charts.

---

## SECTION 4 — DATABASE SCHEMA

### Core Tables
- **`users`**: `id`, `email`, `password_hash`, `country`, `is_banned`, `kyc_status`, `totp_secret` (encrypted), `token_version`.
- **`accounts`**: `id`, `user_id`, `account_type` (phase1/phase2/funded), `account_size`, `current_balance`, `starting_balance`, `peak_balance`, `status` (active/passed/failed/expired), `review_flagged`, `review_flag_reason`.
- **`trades`**: `id`, `account_id`, `instrument`, `direction` (buy/sell), `lot_size`, `open_price`, `close_price`, `status` (open/closed/pending), `stop_loss`, `take_profit`, `demo_pnl`.
- **`platform_settings`**: Key-value store for global rules (e.g., `min_hold_seconds`, `payout_split_pct`, `drawdown_type`).

### Secondary/Admin Tables
- **`admin_immutable_audit`**: Blockchain-style log of all admin actions (`id`, `event_type`, `payload`, `prev_hash`, `entry_hash`).
- **`admin_incidents`**: Tracks high-severity platform events (e.g., feed disconnected).
- **`bbook_pnl`**: Daily aggregation of platform profit/loss (`date`, `amount`, `accounts_failed`, `accounts_passed`).
- **`login_logs`**: `user_id`, `ip_address`, `device_fingerprint`, `timestamp`.

---

## SECTION 5 — API ROUTES & IMPLEMENTATION

### Authentication (`/api/auth`)
- `POST /register`: Advanced registration with device fingerprinting.
- `POST /login`: Dual-flow login. If 2FA enabled, returns `requires2FA: true`.
- `POST /2fa/validate`: Second-step login for TOTP/Backup-code validation.
- `GET /me`: Fetches current user object + theme preferences.

### Trading (`/api/trades`)
- `POST /open`: Market order entry. Validates margin, exposure limits, and market hours.
- `POST /close`: Direct trade liquidation.
- `GET /history`: Returns paginated trade history filtered by account.
- `GET /open-trades`: Real-time floating PnL calculated on the fly.

### Admin (`/api/admin`)
- `GET /overview`: High-density dashboard data (Exposure, Risk Score, Active Accounts).
- `POST /payout/approve`: Approved via a "Four-Eyes" request.
- `POST /kyc/reject`: Requires specific reason; triggers automated email.

---

## SECTION 6 — CORE LOGIC & ENGINES

### 6A. Price Feed Engine
- **Source**: MT5 Bridge (`dwxconnect`).
- **Mechanism**: MT5 writes ticks to `DWX_Market_Data.txt`. Node.js uses `fs.watch` to detect changes instantly.
- **Rollups**: A cron job runs every hour to convert raw ticks into OHLC bars stored in `price_feed_history_1h`.
- **Smoothing**: The system applies an admin-configurable spread to all raw prices to ensure profitability on b-book execution.

### 6B. Trade Execution Engine
- **Math**:
    - **PnL (Buy)**: `(ClosePrice - OpenPrice) * Lots * ContractSize - Commission`.
    - **Margin**: `(Lots * ContractSize) / Leverage`.
- **Loop**: `checkSLTP` runs every 500ms. It uses `FOR UPDATE SKIP LOCKED` on the DB row to prevent race conditions with the challenge engine.
- **Risk Limits**: Hardcoded and Admin-Configurable:
    - **Forex Max Lots**: 0.20 per $1k balance.
    - **Gold Max Lots**: 0.02 per $1k balance.

### 6C. Challenge Engine
- **Drawdown Physics**:
    - **Static Drawdown**: Based on the *starting balance*.
    - **Trailing Drawdown**: Based on the *peak equity/balance*.
    - Formula: `(DrawdownBase - CurrentEquity) / DrawdownBase * 100`.
- **Fraud Engine**:
    - **Opposing Trades**: Detects if a user opens a Buy on Acc-A and a Sell on Acc-B within a tight window to "bridge" risk.
    - **IP Detection**: Flags if >2 users trade from the same IP within 24h.

---

## SECTION 7 — AUTHENTICATION & SECURITY

### Security Hardening
1. **Device Fingerprinting**: Users are blocked from creating multiple accounts from the same machine.
2. **JWT CSRF Protection**: Tokens are stored in **HttpOnly, SameSite=Strict** cookies.
3. **Admin 2FA**: Admin login requires TOTP. There is no password reset for admins (must be manual DB update).
4. **Rate Limiting**: 
    - Auth: 10 req / min.
    - Trading: 30 market orders / min.
    - Admin: 5 failed logins / 15 min.

### Input Sanitization
- All strings are passed through a custom `sanitizeString` utility that strips HTML tags and SQL-specific characters.
- All numbers are converted to `Decimal.js` objects before math.

---

## SECTION 8 — FRONTEND PAGES & COMPONENTS

### Theme System
- **Provider**: `ThemeContext.js` uses `localStorage` for hydration and `PATCH /api/auth/theme` for persistence.
- **Variables**: `--bg-surface`, `--bg-card`, `--accent`, `--accent-glow`.

### Dashboards
- **Trader Dashboard**: Glassmorphic "pill" navigation. Sidebar stays consistent while the `ContentArea` swaps between Home, History, and Chat.
- **Admin Layout**: High-density sidebar. Modular routes (e.g. `AdminPayouts`) are lazy-loaded for performance.

---

## SECTION 11 — TRADING ENGINE SPECIFICS

### Leverage & Exposure
| Asset Class | Leverage | Lots / $1,000 |
| :--- | :--- | :--- |
| Forex (EUR, GBP) | 1:30 | 0.20 |
| Commodities (XAU, XAG) | 1:10 | 0.02 |
| Indices (Planned) | 1:5 | 0.01 |

### SL/TP Mechanics
- If a price gapped over a Stop Loss during a news event, the engine will exit at the **next available tick**, not the SL price (realistic slippage simulator).

---

## SECTION 12 — ENVIRONMENT VARIABLES

- `DATABASE_URL`: Full PostgreSQL connection string.
- `JWT_SECRET`: signing key for traders.
- `ADMIN_JWT_SECRET`: signing key for admins.
- `ADMIN_PASSWORD`: **Must be a bcrypt hash** in production.
- `DWX_PATH`: Absolute path to MT5 internal files.
- `TOTP_ENCRYPTION_KEY`: 32-byte key for TOTP secret storage.
- `FRONTEND_URL`: Used for CORS and email links.

---

## SECTION 13 — SOCKET EVENTS

### Client to Server
- `join_account(accountId)`: Subscribes to updates for a specific account.
- `typing_start(chatId)`: User typing indicator.

### Server to Client
- `price_update({ symbol, bid, ask })`: Sent every tick.
- `account_update({ event, message, pnl })`: Triggered on trade close, pass, or fail.
- `drawdown_warning`: Sent when user hits 80% of their limit.

---

## SECTION 15 — ROADMAP & KNOWN ISSUES

### Known Issues
- **News Feed Lag**: The news feed scraper currently runs every 5 minutes; high-impact news may be missed by 1-2 minutes.
- **Mock Data**: `AdminDashboard.js` charts have some fallback mock data when the `api/admin/overview` is under load.

### Future Roadmap
1. **TradingView Integration**: Full charting library replacement.
2. **A-Book Copier**: Auto-copy profitable traders to a real broker.
3. **Redis Caching**: Planned for price feed to reduce DB load (currently disabled but dependency is present).

---

## SECTION 16 — PAYOUTS & PASS LOGIC

### Flow
1. **Profit Target Hit**: `challengeEngine` detects profit >= target + 0 open trades.
2. **Account Locked**: Account status set to `passed`.
3. **Promotion**: `progressionService` creates NEXT phase account.
4. **Funded Payout**: 
    - Trader requests amount.
    - System verifies that `LastPayoutDate > 14 days`.
    - Payout goes to `admin_four_eyes_requests`.
    - Two admins must approve before `status` becomes `paid`.
