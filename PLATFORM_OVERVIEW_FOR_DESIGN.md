 # Prop-Firm Platform — Full Overview for Design Handoff

Snapshot: 2026-07-31 · Baseline: post multi-tenant removal, commit `5366dc4` · Purpose: everything this platform *has* (routes, pages, nav, design system, API wiring, known issues) assembled as one reference to hand to Claude for a visual redesign pass — without dropping any existing functionality.

---

## 1. What the Platform Is

A proprietary trading ("prop firm") system. Traders sign up, buy a trading challenge (a simulated evaluation account), and if they hit profit targets without breaking risk rules, get upgraded to a "funded account" — trading company capital and keeping a cut of profits. Admins handle KYC review, risk monitoring, and payouts. The system runs its own challenge-rule engine natively rather than depending on a broker for enforcement (max daily loss, drawdown, opposing trades, etc., checked in real time).

**Lifecycle:** Landing → Register → KYC → Buy Challenge → Trade (rules enforced live) → Fail (retry) / Pass (admin review) → Funded → Live trading → Payout request → Admin review → Paid (or Revoked on violation).

---

## 2. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | React 19 + React Router v7 | Nested routes only under `/admin`; dashboard tabs are state, not routes |
| State | Local state + Zustand | No Redux-style global store |
| Realtime | Socket.IO client | Trader dashboard, Chat, admin sidebar badges/alerts |
| Animation | Framer Motion | Page transitions, sidebar collapse, micro-interactions |
| Charting | TradingView iframe widget (live chart) | `lightweight-charts`/`recharts` exist too, only for admin analytics |
| Styling | Hand-rolled CSS custom properties | No Tailwind/MUI/Bootstrap — one token system (see §3) |
| HTTP | axios, httpOnly cookie auth | A typed `services/api.js` exists but several pages bypass it with raw calls |
| Toasts | Two independent systems | `react-hot-toast` (trader) vs custom `AdminToastProvider` (admin) |

---

## 3. Design System — "The Ledger Desk"

Source of truth: `tokens.css`. Concept: editorial financial-print — flat corners, hairline rules, double-border mastheads, serif display type, no shadows, no gradients. Light = "Rag Cotton White." Dark = "Charcoal Noir."

**Typography**
- `--font-display`: Playfair Display — headings/masthead
- `--font-ui`: Source Serif 4 — body/UI text
- `--font-mono`: IBM Plex Mono — labels, stat values, all numbers
- Optional alt pairing: Cormorant Garamond / Lora

**Color primitives** — brand hue *flips* between themes, not just lightness:

| Token | Dark "Night Edition" | Light "Day Edition" |
|---|---|---|
| `--paper` (bg) | `#131211` | `#F7F4EC` |
| `--paper-2` (surface) | `#1B1917` | `#EFEBDF` |
| `--ink` (text) | `#EDE9E0` | `#1A1A18` |
| `--rule` (border) | `#3A3733` | `#C9C2B0` |
| `--gain` | `#4FBE6E` | `#2E6B3E` |
| `--loss` | `#E05A5A` | `#8B1E1E` |
| `--warn` | `#E8B400` | `#A5730A` |
| `--brand-primary` | `#E8B400` (gold) | `#8B1E1E` (deep red) |

Each also carries `-strong`, `-rgb`, `-glow`, and `-soft` variants. A frosted "glass" layer (`--glass`, `--glass-2`, `--glass-hi`) sits over the flat base.

**Structure — deliberately flat**
- Radius: `--radius-sm/md/lg/xl/2xl/pill` are all `0`. No rounded corners anywhere, by design.
- Shadow: all `none`. Hierarchy comes from hairline/double rules, never elevation.
- Spacing scale `--space-1`(4px) → `--space-10`(64px)
- Motion: 160 / 260 / 420ms, eased cubic-bezier

**Three mode overlays**
- `mode-public` — marketing/landing
- `mode-trader` — trader dashboard
- `mode-operator` — admin panel, remaps `--admin-*`

A runtime `BrandingContext` can override brand-color vars for white-labeling, independent of light/dark — preserve this hook.

**Responsive breakpoints**

| Breakpoint | Behavior |
|---|---|
| 1440px | Content max-width caps out |
| 1280px | Trading Terminal's two-column split collapses toward single column |
| 1024px | Trader sidebar → off-canvas/bottom-tab-bar; admin sidebar → overlay |
| 768px | General layout tightening |
| 640px | Grids collapse to 1 column |

---

## 4. Site Map

`/dashboard` and `/admin` are shells that own their own internal navigation — everything under them is NOT a flat route list.

**Top-level routes:** `/` (Landing, public) · `/login` · `/register` · `/dashboard`, `/dashboard/*` (protected shell) · `/chat` (protected) · `/admin` (protected shell) · `/admin/support-appeals-center` (standalone, protected) · `/terms` · `/privacy` · `/checkout` · `/leaderboard` · `/trader/:id` · `/competitions(/:slug)`

**Dashboard internal tabs** (13 — `activePage` local state, NOT separate URLs): Home · Profile · Get Challenge · Rules · Trade · Analytics · KYC · Payouts · Competitions · History · Support · Dispute · Chat

**Admin nested routes** (18 — real `<Route>` children navigated with `<NavLink>`): index → AdminDashboard · `/users` · `/kyc` · `/challenges` · `/funded` · `/trades` · `/analytics` · `/payouts` · `/pnl` [super_admin] · `/settings` · `/step-models` [super_admin] · `/access` · `/command-center` [super_admin] · `/promotion-reviews` · `/leaderboard` · `/violations` · `/competitions(/:id)(/analytics)` · `/accounts/:accountId`

> **Rebuild note:** don't let dashboard tabs grow real URLs (or vice versa) unless that's an intentional, separately-flagged change. `/admin/support-appeals-center` is reachable only via a topbar button and renders with no admin sidebar visible.

---

## 5. Navigation Systems

There is **no single shared Navbar component** — three independent systems exist for three contexts.

### 5.1 Public nav
Landing, Leaderboard, Competitions, CompetitionDetail, TraderProfile: logo (→ `/`) + theme toggle only. Landing uses a transparent variant that opacifies on scroll.

### 5.2 Trader shell
`Sidebar.jsx` — state-driven, not router links: Dashboard · New Challenge · Rules · Trade · Analytics · History · Competitions · KYC (dot badge) · Payouts (count badge) · Live Chat · Appeal · Support · Profile (footer avatar row only, not in the list).

- Header: logo mark + "PROP FIRM" wordmark + "Trader Portal" subtitle (text hides when collapsed)
- Collapse toggle: floating chevron, 220px ↔ 64px, persisted to `localStorage`
- Badges are *data-driven*, not permission-driven: KYC dot (pending/rejected), Payouts count, Dashboard unread-notification count
- Mobile (≤1024px): sidebar replaced by a bottom tab bar, plus an explicit Profile tab not otherwise reachable
- Topbar (inline in `Dashboard.jsx`): live "Terminal Status" indicator tied to socket connection, clickable KYC badge, notification bell + popover, theme toggle, logout

### 5.3 Admin shell
Fully separate auth system from the trader shell — own JWT secret/cookie, own login screen (password + optional TOTP), own socket connection.

`AdminSidebar.jsx` — real NavLink routing, grouped:
- **Overview:** Dashboard
- **Traders:** All Users · KYC Approvals · Challenges · Promotion Review · Funded Accounts
- **Trading:** All Trades · Competitions
- **Analytics:** Analytics
- **Finance:** Payouts · Platform P&L `[SUPER_ADMIN ONLY]`
- **Platform:** Command Center `[SUPER_ADMIN ONLY]` · Access & Security · Settings · Challenge Models `[SUPER_ADMIN ONLY]` · Violations · Leaderboard

> **Role gate — exactly 3 items:** Platform P&L, Command Center, and Challenge Models are hidden from the plain `admin` role. Every other item is visible to any authenticated admin. Badge counts refresh live over Socket.IO (`admin_violation_updated`, `admin_enforcement_event`, `admin_command_center_updated`, `opposing_trade_detected`, `admin_alert`).

**AdminTopBar:** hamburger + breadcrumb ("Admin / CurrentPage") on the left; role/scope chip, theme toggle, Support & Appeals shortcut, notification bell, and profile dropdown (Access & Security / Settings / Logout) on the right.

---

## 6. Full Page Inventory

### 6.1 Public pages

| Page | File | Contents |
|---|---|---|
| Landing | `Landing.jsx` | 9 lazy sections: Hero, LiveStats, Calculator, Features, Scaling, Comparison, WallOfLove, FAQ, Footer |
| Terms / Privacy | `TermsOfService.jsx` / `PrivacyPolicy.jsx` | Static accordions, no API calls |
| Checkout | `Checkout.jsx` | Standalone purchase landing — plan review → order → redirect to payment |
| Login / Register | `Login.jsx` / `Register.jsx` | Login + TOTP step; multi-step signup (form → OTP → creation) |
| Leaderboard / Trader Profile / Competitions(+Detail) | `Leaderboard.jsx` / `TraderProfile.jsx` / `Competitions.jsx` / `CompetitionDetail.jsx` | Each exports a chrome-less content component reused inside the dashboard |

### 6.2 Trader dashboard tabs (inside `Dashboard.jsx`)

| Tab | Component | Key content / endpoints |
|---|---|---|
| Dashboard (Home) | `DashboardHome.jsx` | Stats/account overview, countdown widgets |
| Profile | `DashboardProfilePage.jsx` | `PATCH /api/auth/profile` |
| Get Challenge | `GetChallenge.jsx` | 3-step: model → size (KYC-gated) → confirm → `POST /api/accounts/orders` |
| Rules | `ChallengeRules.jsx` | Progress for selected account, "Trade Now" → Trade tab |
| **Trade** | `TradingPanel.jsx` | See §7 |
| Analytics | `Analytics.jsx` | Equity curve / performance |
| KYC | `DashboardKYCPage.jsx` + `KYCUploadForm.jsx` | Doc upload + live webcam capture → `POST /api/kyc/upload` |
| Payouts | `DashboardPayoutsPage.jsx` | Request form → `POST /api/payouts/request`, history, statement download |
| Competitions | `DashboardCompetitionsPage.jsx` | Embeds chrome-less public competition components |
| History | inline, no separate file | Paginated account history |
| Support | `Support.jsx` | Ticket system — distinct from live Chat |
| Dispute | `Dispute.jsx` | `POST /api/disputes/submit` |
| Chat | `Chat.jsx` | Same component also mounted at standalone `/chat` |

### 6.3 Admin pages

| Page | File | Contents |
|---|---|---|
| Admin Dashboard | `AdminDashboard.jsx` | 6 KPI tiles, trend/pie/funnel/exposure charts, "needs attention" alerts |
| All Users | `AdminUsers.jsx` | Management table, per-user drawer |
| KYC Approvals | `AdminKYC.jsx` | Saved views, SLA/quality widgets, document viewer, approve/reject |
| Challenges / Funded / Trades | `AdminChallenges.jsx` / `AdminFunded.jsx` / `AdminTrades.jsx` | Phase/status filtered tables |
| Analytics | `AdminAnalytics/index.jsx` | 8 tabs: Performance, Risk/Violations, Profitability, Funnel, Behavior, Real-Time, Model Optimization, Compliance |
| Payouts | `AdminPayouts.jsx` | Queue, approve/reject, tags |
| Platform P&L `[super_admin]` | `AdminPlatformPnL.jsx` | Platform-wide P&L by month |
| Settings | `AdminSettings.jsx` | Global config editor |
| Challenge Models `[super_admin]` | `AdminStepModels.jsx` | Targets/drawdown/time-limits per phase, per-size pricing |
| Access & Security | `AdminAccess.jsx` | Admin accounts, 2FA, security flags |
| Command Center `[super_admin]` | `AdminCommandCenter.jsx` | Account Recovery · Trader Control · Money & Risk |
| Promotion Review | `AdminPromotionReviews.jsx` | Monthly phase-promotion queue |
| Leaderboard | `AdminLeaderboard.jsx` | Visibility toggle per trader |
| Violations | `AdminViolations.jsx` | Severity/status filters, 15s auto-refresh |
| Competitions (+Detail, +Analytics) | `AdminCompetitions*.jsx` | List/create with `PrizePoolEditor`, per-comp settings + analytics |
| Account Detail | `AdminAccountDetail.jsx` | Single-account violations/trades/history |
| Support & Appeals Center *(standalone, no sidebar)* | `SupportAppealsCenter.jsx` | 6 tabs: Tickets, Live Chat, Breach Appeals, Notification Center, Compliance Log, ToS Tracking |

Shared building blocks reused across nearly every admin page — treat as a library: `AdminDataTable`, `AdminEntityDrawer`, `AdminStatCard`/`AdminStatGrid`, `AdminFilterBar`, `AdminListToolbar`, `AdminModal`, `AdminActionMenu`, `AdminBadge`, `AdminChart`, `AdminToast`.

---

## 7. Trading Terminal Deep-Dive

`TradingPanel.jsx` — the most complex screen, and the core product surface. Composes `OrderPanel.jsx` (order entry), `TradingViewWidget.jsx` (chart), `SimulatedTradingDisclaimer` + `RiskWarningBanner`, and `Pagination`.

**Layout, top to bottom:**
1. Header — title + live price-feed health pill (polls `GET /api/price-status` every 5s: Live/Degraded/Delayed)
2. `RiskWarningBanner` — dismissible, can float sticky
3. Account selector — pill buttons per trading account
4. Auto-scrolling instrument ticker marquee — bid/ask, pinnable watchlist, pauses on hover/touch
5. Empty/locked/loading states
6. **Main resizable two-column layout** (50–85% split, persisted):
   - **Left:** disclaimer → balance bar (Balance/Floating P&L/Floating Balance/Profit%/Drawdown%/Days Left) → profit-target gauge → drawdown-risk gauge → chart (500px) → phase countdown → Open Positions/Orders table (batch actions, inline modify/partial-close/cancel/close) → Closed Trades & History (CSV export, paginated)
   - **Right (sticky):** `OrderPanel`
7. Passed/Failed/Expired terminal-state full-card messages

**`OrderPanel.jsx` sections:** Market-open/closed banner (weekend/rollover blackout windows computed client-side) → instrument select → bid/ask + spread card → Market/Pending toggle → lot size/SL/TP inputs → live R:R calculator → pending-order fields (4-type grid, OCO sibling option) → submit buttons (Buy/Sell with live prices, or "Place {TYPE}") → account summary footer.

---

## 8. Modals & Multi-Step Wizards

1. **Onboarding tour** (`Onboarding.jsx`) — 7-step full-screen overlay on first login: Welcome → Complete KYC → Choose a Challenge → Rules reference grid → Pass Your Challenge → Request Payouts → Ready. Step-dots, Back/Next, global Skip.
2. **KYC webcam capture** (`WebcamCapture` in `KYCUploadForm.jsx`) — full-screen live preview, Capture/Retake/Use This Photo.
3. **Challenge purchase wizard** (`GetChallenge.jsx` in-dashboard, `Checkout.jsx` standalone) — model → size → confirm modal → order → payment redirect.
4. **Admin generic primitives** — `AdminModal` and `AdminEntityDrawer` (Overview/Timeline tabs), used across ~29 admin files.
5. **Admin login** — 2-step in-page wizard: password → optional 6-box TOTP.
6. **Inline "lightweight wizards"** — the Trading Terminal's partial-close and modify forms expand in-place within table rows rather than opening a dialog; give these the same design care as a modal.

---

## 9. Data-Flow Map

Backend mount prefixes (`backend/server.js`): `auth.js`→`/api/auth`, `accounts.js`→`/api/accounts`, `trades.js`→`/api/trades`, `kyc.js`→`/api/kyc`, `payouts.js`→`/api/payouts`, `chat.js`→`/api/chat`, `competitions.js`→`/api/competitions`, `disputes.js`→`/api/disputes`, `billing.js`→`/api/billing`, plus 4 files (`admin.js`, `adminViolations.js`, `adminAnalytics.js`, `adminCompetitions.js`) all sharing `/api/admin` — treat as one logical admin API split by feature area.

**Full backend route inventory:**

| File | Mount | Auth | Purpose |
|---|---|---|---|
| `auth.js` | `/api/auth` | mixed | register/login, 2FA, profile, theme pref, password reset |
| `accounts.js` | `/api/accounts` | mostly auth | sizes, step models, rules, create/list, orders, purchase-limit |
| `trades.js` | `/api/trades` | auth | candles, open/close/cancel/modify, history, export, analytics, batch, screenshots |
| `admin.js` +3 more | `/api/admin` | admin / super_admin / capability | ~29 areas — sessions, users, overview, saved-views, risk/compliance, Command Center, settings, market ops, rules, enforcement, feature flags, notifications, disputes, kill-switch |
| `competitions.js` | `/api/competitions` | public / optional-auth / auth | list, detail, leaderboard, join |
| `billing.js` + webhook | `/api/billing` | auth / signature-verified | Stripe checkout session + webhook |
| `chat.js` | `/api/chat` | auth (trader) / admin | conversations, messages, admin inbox, stats |
| `setup.js` | `/api/setup` | public, self-disabling | first-run bootstrap |
| `kyc.js` | `/api/kyc` | auth | upload, status |
| `payouts.js` | `/api/payouts` | auth | request, history, statement, settings |
| `support.js` | `/api/support` | auth (mixed) | tickets — **dead file**, superseded by inline handlers in `server.js` |
| `disputes.js` | `/api/disputes` | auth / admin | submit, my-disputes; admin all/:id |
| `swagger.js` | `/api/docs` | public | OpenAPI spec + Swagger UI |

---

## 10. Roles & Permissions

| | Trader | Admin | Super Admin |
|---|---|---|---|
| Auth system | `AuthProvider`, cookie `token` | `AdminSessionProvider`, separate secret, cookie `admin_token` (shared row) | (shared row) |
| Tiering signal | `account_type` + `kyc_status` — no role field | `role = 'admin'` | `role = 'super_admin'` |
| Nav visibility | full trader sidebar; badges reflect data, not permission | full admin sidebar minus 3 items | full admin sidebar |
| Effective capabilities | own data only | today, effectively equal — RBAC scaffolding exists but only `super_admin` is granted any capability wildcards | (shared row) |

---

## 11. Dead Code — Do Not Rebuild

Present in the repo but not live. Don't spend rebuild effort recreating these faithfully.

- **`components/PriceChart.jsx`** — self-contained `lightweight-charts` OHLC chart, not imported anywhere. The real chart is the TradingView widget.
- **`components/TwoFactorSetup.jsx`** — a complete trader-facing 2FA flow, fully built but never mounted. Traders currently have **no** way to enable 2FA themselves — flag as an open product decision (resurrect into Profile tab, or drop).
- **`components/MultiChartGrid.jsx`** — deleted from the repo, zero remaining references. No multi-chart layout exists today.
- **`components/trading-panel/*`** (Header, PriceTicker, AccountSelector, utils) — an abandoned in-progress extraction; none are wired into the live `TradingPanel.jsx`, which still inlines everything.
- **`pages/admin/AdminChat.jsx, AdminDisputes.jsx, AdminEmailJobs.jsx`** — orphaned, not referenced by any route. Superseded by tabs inside `SupportAppealsCenter.jsx`.
- **`backend/routes/support.js`** — not mounted; `/api/support/*` is implemented inline in `server.js` instead (backend-only detail).

---

## 12. Fix These, Don't Replicate Them

From a completed full-project audit (2026-07-30). Concrete bugs in the current build — the rebuild is the chance to correct them, not reproduce them.

**Largest visual inconsistency** — The Trading Terminal never migrated to the flat Ledger Desk tokens. `App.css`'s `.stat-card`/`.glass-panel`/`.order-panel` plus inline styles in `Sidebar.jsx`/`OrderPanel.jsx`/`TradingPanel.jsx` still use the old rounded/glassmorphic look, even though `tokens.css` defines `--radius-*:0` / `--shadow-*:none` that the rest of the app already follows.

**Safety-relevant** — Severity-tier colors collapsed to a single gray in 3 places — the password-strength meter (`Login.jsx`), the drawdown-risk gauge in `TradingPanel.jsx` (medium and high risk currently look identical to the trader), and the profit-target progress bar. Reads like a mechanical find/replace mistake during a tokens migration.

**Broken CSS, not a design choice** — `GetChallenge.jsx`'s `Pill` component does string concatenation (`${color}15`) expecting a hex color, but callers pass CSS variables like `"var(--accent)"` — producing invalid CSS. Every badge on that page loses its background tint.

**Non-functional as shipped** — `AdminTopBar.jsx`'s notification bell is fully hardcoded — fake unread count, no handlers, static "Nothing yet." placeholder. Wire it up or omit it; don't reproduce a fake bell.

---

## 13. Quick Reference: Token Cheat Sheet

- No rounded corners, no shadows — hairline rules (`--rule`) build hierarchy instead.
- Serif display (Playfair Display) for headings, serif body (Source Serif 4), monospace (IBM Plex Mono) for every numeric/stat value.
- Brand color is gold `#E8B400` in dark mode, deep red `#8B1E1E` in light mode — a hue change, not a lightness change.
- Three CSS "modes" (`mode-public`/`mode-trader`/`mode-operator`) scope token remapping per section — reuse this pattern rather than one-off page styles.
- Fluid clamp-based gutters; hard breakpoints at 1440 / 1280 / 1024 / 768 / 640px.

---

*Assembled from direct source reads plus research passes over the current codebase (see `PROJECT_SYSTEM_DOCUMENTATION.md` for deep backend/infra architecture). Source of truth is the code; this is a snapshot for design handoff, not a spec to hand-enforce.*
