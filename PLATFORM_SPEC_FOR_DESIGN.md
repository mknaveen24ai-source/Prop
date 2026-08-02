# Prop Trading Firm Platform — Spec for Design

Describes the platform **as actually built** in this codebase today (verified against source, not aspirational). Compact, page-by-page. Traders buy challenge accounts, pass profit/drawdown rules, get funded, get paid.

---

## PUBLIC SITE

### Landing Page
Sticky navbar: logo left, anchor links center (Funding, Features, How It Works, Refer & Earn, FAQ) + `/transparency` link, Login + Get Funded right.
Sections in order: **Hero** (headline, subtitle, Start Challenge / View Accounts CTAs, 3 stat pills) → **Live Stats bar** (4 animated counters: Total Paid Out, Funded Traders, Countries, Same-Day Payout Rate) + scrolling recent-payouts ticker → **Features grid** (6 cards: Instant Payouts, Real-Time Dashboard, Transparent Rules, Multi-Phase Challenges, Affiliate Program, Trading Competitions) → **Calculator** (size buttons $10K–$200K → fee/target/drawdown/split/est. payout card → Start Challenge) → **How It Works** (Buy → Pass Phase 1 → Pass Phase 2 → Get Funded) → **Testimonials** → **Affiliate teaser** (Share → Friend buys → You earn) → **Comparison table** → **FAQ accordion** → **Footer** (4 columns + copyright/risk disclaimer bar).
All content (logo, hero copy, tagline) is theme/branding-driven, not hardcoded.

### Login Page
Email, Password (show/hide toggle), Login button, Forgot Password link, Register link. Also handles, in the same component: **2FA** step (6-digit boxed TOTP input, auto-advance, auto-submit on 6th digit, paste support) if enabled, and a **forgot/reset-password** flow (email → reset code → new password with live strength meter).

### Register Page
**Two-step flow, not single-page**: Step 1 form — Full Name, Email, Password (strength meter), Country dropdown, Phone/WhatsApp (required for OTP), Referral Code (optional, live-validated with discount preview, prefillable via `?ref=`), Terms + residency-eligibility checkbox. Step 2 — 6-digit phone OTP (60s resend cooldown), auto-registers on verify.

---

## GET CHALLENGE / BUY CHALLENGE FLOW

Two entry points, same underlying steps:
- **From dashboard** ("New Challenge"): Step 1 — pick model (1-step/2-step/3-step cards: phase count, Phase‑1 target %, max drawdown %, time limit, price range) + "How it works" 3-step explainer. Step 2 — pick account size (buttons for **$5K/$10K/$25K/$50K/$100K/$200K/$400K**, each with OPEN/LOW/FULL/UNAVAILABLE pill + live remaining-slots + price). Confirm modal (size, target %, days, max DD %, price incl. referral discount) → creates order → **redirects to Stripe-hosted checkout** (no in-app card form).
- **From landing / logged out**: Calculator → `/checkout` review page (model, discounted price, targets, drawdown, min trading days, time limit, profit split) → Register/Login CTA, or "Proceed to Payment" (same Stripe redirect) if logged in. Also accepts a **prize-voucher code** (from winning a competition) to skip payment entirely.

Rules by model (seeded defaults): 1-step 16% target/45 days; 2-step 10%→8%; 3-step 8%→6%→6%; all use 4% max (trailing) drawdown, 2% daily drawdown, 15% consistency rule, 5 min trading days. Funded stage: 4% max DD, 2% daily DD (locks account), 75% profit split, weekly payout cadence, requires 6% min net profit + 10 trading days before first payout.

---

## TRADER DASHBOARD

### Shell
Sidebar nav (exact order): **Dashboard, New Challenge, Rules, Trade, Analytics, History, Competitions, KYC, Payouts, Affiliate, Live Chat, Appeal, Support.** Logo lives in the sidebar header; a Profile page exists but is reachable only via the sidebar-footer avatar (desktop) or a mobile bottom-nav tab, not a main nav item. KYC nav item shows a colored status dot; Payouts and Dashboard show count badges. Collapsible sidebar (persisted).
Topbar (no logo/avatar here): connection-status badge, trader name + KYC badge, notification bell (unread count + dropdown, mark-all-read/clear — **stored in browser localStorage, not server-persisted**), theme toggle, logout. A separate sticky, dismissible **announcement banner** sits above the topbar/content (4 color variants, polled every 5 min). First login shows an onboarding walkthrough overlay.

### Dashboard Home
Account switcher (cards per account: type, size, short UID, status). Start-Challenge card when no active/only-failed accounts. Quota-closed warning with 4-box (D/H/M/S) countdown to reset. Drawdown warning banner at ≥75% used (critical style ≥90%). KPI grid (6): **Current Balance, Live Equity, Floating P&L, Profit %, Trades Today, Days Remaining.** Challenge-expiry countdown (4-box, live, expired state). Profit-target progress bar (Earned/Target/Remaining) — hidden once funded. Risk cards: Drawdown bar (used/remaining) + circular Consistency Score gauge (0–100, best-day % vs firm limit). Account Info table (Trader ID, Account ID, Type, Size, Starting Balance, Current Balance, Equity, Status) + Rules table (Profit Target %, Max Drawdown %, Time Limit, Max Daily Trades, Min Hold Time, Forex/Commodity Lots per $1K, Profit Split %) with a "Full Rules" link to the standalone Rules tab. Locked-account state card when applicable.

### Trade Tab
Order entry: instrument dropdown, live Bid/Ask/Spread, Market/Pending toggle, Lot Size, Stop Loss, Take Profit, inline R:R preview, Buy/Sell buttons (show live price). Pending mode adds Order Type (buy/sell limit/stop), Order Price, and an **OCO sibling-order** form. Embedded TradingView candlestick chart (theme/instrument-synced). **One unified, filterable "Positions & Orders" table** (All/Open/Pending — not two separate tables): Symbol, Type, Lots, Open/Target, Current, SL, TP, P&L, Actions (Modify/Partial-Close/Close for open incl. Move-to-BE; Modify/Cancel for pending). Separate Trade History table below: Symbol, Type, Lots, Open Price, Close Price, Reason, P&L (paginated, CSV export incl. timestamps, "Repeat Last Trade"). Extras: batch actions (Close Winners/Losers, Breakeven Winners), live feed-health indicator, resizable chart/panel split, pinnable instrument ticker, Risk Warning + Simulated-Trading disclaimers.

### Analytics Tab
KPI cards (8): Total Trades, Win Rate, Total P&L, Avg Hold Time, Best Trade, Worst Trade, Discipline Score, Risk Consistency. Balance/equity curve chart (1D/1W/1M/Full Challenge + replay scrubber). **No separate drawdown chart** — drawdown is a per-row bar inside a Trade-by-Trade History table (#, Date, Balance, P&L, Drawdown). Win-Rate breakdowns by Symbol, Weekday, and Session. Hour × Weekday P&L heatmap + "Best Weekday Pocket" summary. Extra sections: Hold-Time Analytics, Best/Worst Setups, Breach Analysis (cause, target progress, drawdown usage, days remaining), Payout Readiness Forecast (est. payable, KYC status, blockers), AI-style improvement suggestions.

### KYC (tab & standalone page — identical)
Status banner: **Approved / Pending / Rejected / Not Submitted** (not-submitted = no record yet; a rejected resubmission just resets status to Pending — there is no separate "Resubmitted" state). Upload form: Country of Residence, Document Type (Passport/National ID/Aadhaar/Driver's License/Residence Permit), Document Number, **ID Front + ID Back** uploads, and Selfie via file upload **or live in-browser webcam capture**. Approved → success message. Rejected → reason shown + form re-opens.

### Payouts Tab
Eligibility card: Available Profit, Profit Share %. (No funded account → gated empty state.) Request form: Amount ($50 min, capped at available profit, live "you receive" preview), Payment Method (**Crypto / Bank Transfer / Wise / PayPal**), Payment Details (free text). History table: Trader ID, Account ID, Amount, You Receive, Method, Status, Requested, Paid — plus a Download Statement button once any payout is paid.

### Affiliate Tab
KPI cards (4): Lifetime Commission, Available Balance, Total Referrals, Paying Referrals. Referral link box + copy button. Commission tier shown as a **progress card** (current tier %, progress to next tier) rather than a full tiers table. Referrals table (Name, Country, Joined, Status, Commission Generated). Commission Ledger table (From, Order Amount, Rate, Commission, Status, Earned). Payout History table (Amount, Method, Status, Requested, Paid). Own payout-request form (settles entire available balance).

### Competitions Tab + Detail
List: title, status badge (Upcoming/Live/Completed/Cancelled), date range, starting balance, entry fee, participants/max. Detail: header + description + date range; Rules card (Starting Balance, Max Drawdown, Entry Fee, Participants); **Prize Pool as a flat list of admin-configured rank labels** (not a fixed amount table); Participation card (join status/rank, KYC-gated Join button); a **Prize Voucher claim card** for competition winners (redeemable at checkout for a free challenge); Leaderboard (rank w/ medal icons top-3, trader name incl. DEMO/DISQUALIFIED tags, country, Profit %, Profit $), auto-refreshes every 15s, rows link to a standalone public Trader Profile page.

### Live Chat Tab
Header shows a single "{N} active" badge + unread sub-badge (no row of stat cards). "+ New Chat" → Subject-only form. Conversation list: subject, status pill, last-message preview + time, unread badge. Thread: header (subject, status, Close button), message bubbles (You right / Support left) with date separators, auto-scroll, input + Send (disabled once closed). Real-time via Socket.IO. **Typing indicator is not actually rendered** — the client emits typing events but the receiving handler is a no-op, so no "is typing…" UI appears.

### Support Page
Submit Ticket / My Tickets tabs. New ticket: Category grid (Account Issue, Trading Problem, KYC/Verification, Payout Request, Technical Bug, Other), Email (if logged out), Subject, Message (20+ chars). Tickets table: Ticket, Status, Date → opens an HTTP-polled reply thread (separate from the websocket Live Chat system). Side panel: "Submitting As" card + Response Times table.

### Appeal / Dispute Page
Only failed/expired accounts are eligible. Form: Account dropdown, Reason grid (drawdown calc error, price feed/slippage, platform error, wrong close, unjust expiry, other), Description (30–2000 chars). Side panel: 4-step process explainer + My Disputes list (id, status, reason, account, date, admin response) shown as a list, not a table.

---

## PUBLIC LEADERBOARD & TRANSPARENCY

### Public Leaderboard
Standalone page, top-20 active funded accounts, ranked list (medal icons for top 3 — no separate podium section). Columns: rank, name, country, account size, Trader/Account ID, Profit %, Profit $. No time-period/account-type filters and no charts — rows link to a public Trader Profile page.

### Transparency Page
7-tab dashboard: **Overview** (8 KPI cards: Total Revenue, Annualized Run Rate, Total Payouts, Largest Single Payout, Active Traders, Funded Traders, Pass Rate, Funded Trader AUM — auto-refresh 60s) · **Revenue** (range pills + combo bar/line chart) · **Evaluations** (3 KPI cards + Started→Phase1→Phase2→Funded funnel + pass-rate-by-model bar chart) · **Traders** (range pills + combo chart) · **Funded** (dual-axis line: funded count + capital AUM) · **Payouts** (2 KPI cards + paginated anonymized table: #, Trader, Amount, Method, Date) · **Activity** (live feed + Top Performers list).

---

## ADMIN PANEL

### Admin Login
Not a separate route — rendered inline whenever any `/admin/*` URL is hit unauthenticated. Step 1: Email (optional — blank allowed for one-time legacy bootstrap) + Password. Step 2: 6-digit boxed TOTP, auto-advance/auto-submit/paste.

### Admin Dashboard
KPI row (6): Total Users, Active Challenges, Funded Traders, Total Paid Out, Platform PnL, Pending KYC. "Requires Attention" row (4, clickable-to-navigate): Pending KYC, Pending Payouts, Flagged Payouts, Banned Users. Charts: signup+challenge trend, account-status pie, pass-rate funnel, live risk-exposure bar + Live Hedge Exposure table. No recent-activity feed and no dedicated quick-action buttons — the KPI tiles themselves navigate.

### All Users
Stat cards (Total Traders, Pending KYC, Funded Traders, Needs Attention). Filters: KYC status, Active/Banned, Risk tier, Funded-only, search. Toolbar: saved views, density, column visibility, CSV export, bulk Tag. Table: Trader (avatar/name/email), UID, Country, KYC, Accounts, Risk, Classification, Tags, Joined, Status. Drawer (Overview + Timeline tabs): badges, info grid, quick actions, tags, classification/priority/notes; Ban/Unban always available, Revoke Sessions/Manual Account are super-admin only.

### KYC Approvals
Filter tabs: Pending / Approved / Rejected / All. Stat cards (Pending Queue, Over SLA, Quality Risk High, Missing Files). Table: Trader, Country, Submitted, KYC Status, SLA, Quality, Classification, Tags. Review UI is a **persistent split-pane**, not a modal: zoomable ID Front/Back/Selfie viewer + trader info + Quality Flags; Approve / Reject (reason: unclear doc, wrong type, expired, mismatch, other). Bulk: Tag, Approve Selected, Reject Selected.

### Challenges
Stat cards (Total, Active, Breached/Locked, Review Flagged). Filters: Phase, Status, Review-flagged, Month, Promotion-review. Table: Account, Trader, Phase, Status, Promotion Review, Size, Balance, Risk, Tags, Created. Row → "Manage Account" modal (Override Reason, Force Pass & Queue Review, Breach, Force Close Open Trades, fixed 14-day Extend, Balance Adjustment). The **full lifecycle action set** — Force Pass, Breach, Lock, configurable Extend Days, Restore Active, Restore + Reset, Replace, Revoke Funded, Clear Review Flag — lives on a separate **Account Detail page** (`/admin/accounts/:id`, reached from Violations/Command Center/Funded, not linked from this table), which also shows 5 summary cards, an Account Snapshot, per-account Violations table, and Automation Action History.

### Funded Accounts
Stats row (Funded, Active Funded, Review Flagged, Open Trades). Table: Account, Trader, Status, Size, Balance, Payouts, Split, Risk, Tags, Created. Actions: Preview drawer, Manage modal (Force Close, Revoke & Lock, Balance Adjustment), Open Account Detail.

### All Trades
Stats (Visible, Open, Pending, Closed). Filters: Direction, Status, search. Table: Trade ID, Account/Trader, Instrument, Direction, Lots, Open/Close Price, SL/TP, P&L, Status, Opened. Force-Close action on open trades. (Loads all trades client-side — no server-side pagination on this page, unlike the others.)

### Payouts
Filter tabs: All / Pending / Paid / Rejected + Flag + Dispute-linked filters. Table: Request ID, Trader, Requested Amount, Destination, Risk, Tags, Requested Date, Status (+Flagged). Actions: Preview, Mark Paid, Reject, Flag/Unflag (super-admin). **Only bulk action here is Tag Selected** — bulk Approve/Reject/Flag live in Command Center's Money & Risk Queue instead.

### Violations
Filter chips: Severity (All/Critical/High/Medium/Low) + Status (All/Open/Resolved) + dynamic top-8 type chips. Table: Type, Severity, Account/User, Instrument, Message, Hits, Last Detected, Status. Resolve modal: resolution type (resolved/waived/false positive) + note; super-admin extras: Flag For Review, Lock Account, Force Close Open Trades. Bulk: Resolve/Waive/Mark False Positive. Auto-refreshes 15s. **Real-time critical-violation toast confirmed** — fires globally on any admin page via websocket, not just this one.

### Chat (Support Inbox)
The originally-built full inbox (KPI cards, saved views/columns/density/export toolbar, bulk Mark Resolved/Open) exists in code but **is dead — not routed or linked anywhere.** The actually-reachable chat inbox is a "Live Chat" section bundled inside a separate **Support & Appeals Center** page (opened via a small topbar icon, not the sidebar) alongside 5 unrelated sections (Support Tickets, Breach Appeals Queue, Notification Center, Compliance Log, ToS & Agreement Tracking). The live version has: 4 KPI cards (Open/Pending/Needs Attention/Messages‑24h), a plain search+status-filter toolbar (no saved views/columns/density/export), conversation list + message thread + reply box, real-time Socket.IO updates — but **no multi-select/bulk-actions bar**.

### Analytics
8 filter-chip sections (not literal tabs): **Trader Performance** (stat cards + sortable table + per-trader equity curve on select — no P&L histogram exists) · **Risk & Rule Violation** · **Firm Profitability** (Net Profit/Payout Ratio/Fees/Payouts cards + pass-rate-by-model chart) · **Funnel & Conversion** (acquisition + challenge funnels, phase-timing, conversion-by-tier) · **Trade Behavior** · **Real-Time Monitoring** · **Model Optimization** · **Compliance & Audit** (read-only Trade/Violation/Payout/Account-Activity/Suspicious-Activity log tables, CSV export per section). No dedicated KYC-processing-time metric (SLA lives on the KYC page) and no dedicated payout-metrics chart (only a raw table under Compliance & Audit).

### Competitions
List table (Title, Type, Status, Start, End, Participants). Create form: Title, Type (weekly/monthly/custom), Start/End datetime, Starting Balance, Max Participants, Ranking Metric, Max/Daily Drawdown %, Prize Pool editor. Detail: settings (locked once started, except description/prizes), Disqualify entry, Correct balance, bot-entrant management, link to a separate Competition Analytics page. **Ending is automatic/time-based** (scheduler state machine) — the only manual action is Cancel, there is no manual "End Competition" button.

### Settings
**Single scrollable page — no tabs.** Two editors up top (Per-Size Monthly Allocation quotas, Affiliate Commission Tiers), then 8 grouped cards: Account Allocation, Challenge Workflow, Funded & Payouts, Trading Rules, KYC & Compliance, Automation & Safety, Affiliate Program, Security & Payment Provider (Stripe keys only). **No Branding tab** (only a plain-text platform name; no logo/color editing anywhere in admin). **No Notifications tab** here (a separate notifications composer/log exists elsewhere with no confirmed delivery pipeline). **No Announcements tab** (the global banner is its own simple on/off + text setting, not part of this page). **No general Security tab** beyond payment keys (2FA/session management is on the separate Access & Security page).

### Platform P&L (super admin only)
6 summary cards: Filtered Edge, Filtered Fees, Trader Win Rate, Closed Trades, Total Traders, Funded Accounts. One area chart (B-Book Edge + Fee Revenue, last 30 closed trades). Table of closed funded trades with saved views/density/columns/export + drawer. **No pass/fail donut chart exists anywhere** — closest is an Account-Status pie (Phase1/Phase2/Funded/Failed/Passed/Expired) on the main Admin Dashboard.

### Command Center (super admin only)
3 chip-tabs: **Account Recovery Queue** (bulk: Restore Active, Restore + Reset, Replace, Lock, Clear Review Flag, Extend Days, Force Close Trades) · **Trader Control Queue** (bulk: Ban, Unban, Revoke Sessions, Approve/Reject KYC, Manual Account) · **Money and Risk Queue** (bulk: Flag/Unflag Payout, Approve/Reject Payout, Waive Violation). Each has summary cards, tab-specific filters, saved-views/density/columns/export toolbar, and a side drawer with the same actions individually. Real-time refresh via websocket. Revoke Funded remains single-account-only (Account Detail page) — not part of any bulk set.

### Access & Security
Current-admin cards (Role, Auth Source, 2FA status). 2FA enroll/disable (QR + secret + verify, backup codes). Super-admin-only Security Checklist (DB-backed Admin Migration, Legacy Env Fallback, Admin TOTP Coverage, Secret Hygiene). "Create Platform Admin" form (Email, Full Name, Password — **sets the password directly**, not an email invite link). Admin users table: Admin, Status, 2FA, Last Login, Actions (Revoke Sessions, Reset Password, Disable/Re-enable). **No admin-action audit log on this page** — a "Compliance Log" exists but lives on the unrelated Support & Appeals Center page and logs trade/violation/payout/account events, not admin logins/approvals/setting changes.

### Leaderboard (Admin View)
Full trader names visible (not masked). Stat cards (Ranked Traders, Visible, Hidden, Avg Win Rate). Table: Rank, Trader, Country, Account, Profit $, Profit %, Win Rate, Trades, Visible. Per-row + bulk Show/Hide Trader, visibility filter, drawer with the same action.

---

## ADDITIONAL PAGES FOUND IN CODE (not in original scope, kept for completeness)

**Trader-side:** standalone **Rules** tab (full challenge-rules reference, linked from Dashboard Home); standalone **History** tab (separate from Analytics); **Profile** page (avatar-only access); public standalone **Trader Profile** page (linked from Leaderboard/Competition rows); first-login **Onboarding** walkthrough overlay.

**Admin-side:** **Affiliates** section (list, per-affiliate detail, affiliate payouts — full admin API); **Trading Economics / Step Models** pages (super-admin, edit per-model/per-size pricing & rules); **Promotion Reviews** queue (manual phase-promotion review); **Support & Appeals Center**'s other bundled sections beyond Live Chat — Support Tickets, Breach Appeals Queue, Notification Center, Compliance Log, ToS & Agreement Tracking; competition **bot-account** seeding tools; two admin pages that exist but are **orphaned/unrouted** (Disputes, Email Jobs) — Command Center's "Open Dispute" action currently points at the unrouted Disputes page.

---

## PLATFORM MECHANICS (not a page, but affects design)

- Account sizes: $5K / $10K / $25K / $50K / $100K / $200K / $400K across 1-step/2-step/3-step models.
- Checkout is always a **Stripe-hosted redirect** — no in-app card-entry form anywhere.
- KYC has 3 real statuses (Approved/Pending/Rejected; "Not Submitted" = no record) — no distinct "Resubmitted" state. Files are stored **unencrypted** on disk (an encryption utility exists in the codebase but is never called).
- Payout payment method is free text server-side, not a fixed enum — treat "Crypto/Bank/Wise/PayPal" as UI-suggested options, not enforced values.
- Violations use 4 severities (low/medium/high/critical) with real-time push to both the admin room and the affected trader's own session.
- Trading-restriction flags (no martingale/grid trading/EA bots/hedging) are stored per challenge model but **not enforced** by the trading engine.
- Live prices come from a real MT4/5 bridge; trades are booked internally (b-book) against that feed — not a simulated/random price generator.
