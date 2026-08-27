# Surface 06 — Admin Panel

> Paste `00-PLATFORM-CONTEXT.md` and your theme before this file.

The operations console. Separate login, separate session, separate navigation from the trader
app — it shares the visual language and nothing else. Build the shell and the shared component
library first, then request pages one at a time; there are eighteen of them and they are 80%
the same five components.

**Who uses it:** a small team doing repetitive, consequential work — approving identity
documents, releasing money, closing accounts. Optimise for throughput and for not making a
mistake. Density over comfort, confirmation over speed on anything irreversible.

---

## 1. Build this library first

Nearly every page below is a composition of these. Getting them right once is most of the job:

- **Data table** — sorting, server-side pagination, row selection, bulk-action bar, saved
  views, density toggle, column visibility, CSV export, empty state, loading state
- **Entity drawer** — a side panel with `Overview` and `Timeline` tabs, opened from a row
- **Stat card** and **stat grid**
- **Filter bar** — filter chips and dropdowns above a table
- **List toolbar** — search, saved views, density, columns, export
- **Modal**
- **Action menu** — per-row overflow actions
- **Badge** — status and severity
- **Chart** wrapper
- **Toast** — including a global one for real-time critical alerts

The **bulk-action bar** deserves specific attention: it appears on selection, states how many
rows are selected, and every destructive action in it confirms with the count and the
consequence spelled out.

## 2. The shell

### Login

Not a separate route — rendered inline whenever any `/admin/*` URL is hit unauthenticated.

- Step 1: Email (optional — blank is permitted for a legacy bootstrap path) and Password
- Step 2: six boxed inputs for a TOTP code, with auto-advance, paste support, and auto-submit
  on the sixth digit

### Sidebar

Real routed links, grouped with group labels:

- **Overview** — Dashboard
- **Traders** — All Users · KYC Approvals · Challenges · Promotion Review · Funded Accounts
- **Trading** — All Trades · Competitions
- **Analytics** — Analytics
- **Finance** — Payouts · Platform P&L `[SUPER ADMIN]`
- **Platform** — Command Center `[SUPER ADMIN]` · Access & Security · Settings · Challenge
  Models `[SUPER ADMIN]` · Violations · Leaderboard

**Exactly three items are role-gated** — Platform P&L, Command Center, and Challenge Models.
Everything else is visible to any authenticated admin. Hide the gated items rather than
disabling them.

Badge counts on nav items update live over a socket. Collapses to an overlay on narrow
screens.

### Top bar

- Left: hamburger and a breadcrumb reading `Admin / {Current Page}`
- Right: a role/scope chip, theme toggle, a **Support & Appeals** shortcut icon, a
  notification bell, and a profile dropdown (Access & Security · Settings · Logout)

*The notification bell in the current build is entirely hardcoded — fake count, no handlers,
static empty text. Either wire it to real data or leave it out. Do not reproduce a decorative
bell.*

### Global real-time behaviour

Critical violations fire a toast on **any** admin page, not just the Violations page. Sidebar
badges, Command Center, and Violations all refresh live.

---

## 3. Pages

### Dashboard — `/admin`

Six KPI tiles: Total Users · Active Challenges · Funded Traders · Total Paid Out · Platform
P&L · Pending KYC.

A "Requires Attention" row of four, each clickable through to its queue: Pending KYC · Pending
Payouts · Flagged Payouts · Banned Users.

Charts: a signup-and-challenge trend, an account-status pie (Phase 1 / Phase 2 / Funded /
Failed / Passed / Expired), a pass-rate funnel, and a live risk-exposure bar with a Live Hedge
Exposure table.

**No activity feed and no quick-action buttons** — the KPI tiles themselves are the navigation.

### All Users — `/admin/users`

Stat cards: Total Traders · Pending KYC · Funded Traders · Needs Attention.
Filters: KYC status, Active/Banned, risk tier, funded-only, search.
Toolbar: saved views, density, column visibility, CSV export, bulk Tag.
Table: Trader (avatar, name, email) · UID · Country · KYC · Accounts · Risk · Classification ·
Tags · Joined · Status.
Drawer: badges, info grid, quick actions, tags, classification, priority, notes. Ban/Unban
always available; Revoke Sessions and Manual Account are super-admin only.

### KYC Approvals — `/admin/kyc`

Filter tabs: Pending / Approved / Rejected / All.
Stat cards: Pending Queue · Over SLA · Quality Risk High · Missing Files.
Table: Trader · Country · Submitted · KYC Status · SLA · Quality · Classification · Tags.

**The review UI is a persistent split-pane, not a modal.** One side is a zoomable document
viewer for ID Front, ID Back, and Selfie; the other holds trader info and quality flags, with
Approve and Reject actions. Reject requires a reason: unclear document · wrong type · expired ·
mismatch · other.

This is the highest-volume repetitive task in the panel. The reviewer should be able to work
through a queue without the layout moving between records, and should be able to do it from the
keyboard. Document zoom and pan need to be genuinely good — this is someone squinting at a
photograph of a passport.

Bulk: Tag, Approve Selected, Reject Selected.

### Challenges — `/admin/challenges`

Stat cards: Total · Active · Breached/Locked · Review Flagged.
Filters: phase, status, review-flagged, month, promotion-review.
Table: Account · Trader · Phase · Status · Promotion Review · Size · Balance · Risk · Tags ·
Created.

Row opens a **Manage Account** modal with a limited action set: Override Reason, Force Pass &
Queue Review, Breach, Force Close Open Trades, a fixed 14-day Extend, and Balance Adjustment.

The **full** lifecycle action set lives on the Account Detail page, not here.

### Funded Accounts — `/admin/funded`

Stats: Funded · Active Funded · Review Flagged · Open Trades.
Table: Account · Trader · Status · Size · Balance · Payouts · Split · Risk · Tags · Created.
Actions: preview drawer, a Manage modal (Force Close, Revoke & Lock, Balance Adjustment), and
a link to Account Detail.

### All Trades — `/admin/trades`

Stats: Visible · Open · Pending · Closed.
Filters: direction, status, search.
Table: Trade ID · Account/Trader · Instrument · Direction · Lots · Open/Close Price · SL/TP ·
P&L · Status · Opened. Force-Close available on open trades.

*This page loads all trades client-side with no server pagination, unlike every other table.
Design for a table that can be very long.*

### Analytics — `/admin/analytics`

Eight sections selected by filter chips, not tabs:

1. **Trader Performance** — stat cards, a sortable table, and a per-trader equity curve shown
   on selection. No P&L histogram.
2. **Risk & Rule Violation**
3. **Firm Profitability** — Net Profit, Payout Ratio, Fees, Payouts cards plus a pass-rate-by-
   model chart
4. **Funnel & Conversion** — acquisition funnel, challenge funnel, phase timing, conversion by
   tier
5. **Trade Behavior**
6. **Real-Time Monitoring**
7. **Model Optimization**
8. **Compliance & Audit** — read-only log tables for Trade, Violation, Payout, Account
   Activity, and Suspicious Activity, each with its own CSV export

No KYC processing-time metric here (SLA lives on the KYC page) and no payout-metrics chart
(only the raw table under Compliance & Audit).

### Payouts — `/admin/payouts`

Filter tabs: All / Pending / Paid / Rejected, plus flag and dispute-linked filters.
Table: Request ID · Trader · Requested Amount · Destination · Risk · Tags · Requested Date ·
Status (with a flagged indicator).
Actions: Preview, Mark Paid, Reject, and Flag/Unflag (super-admin only).

**The only bulk action here is Tag Selected.** Bulk approve, reject, and flag deliberately live
in Command Center instead — do not add them here.

This page moves real money. `Mark Paid` needs a confirmation that restates the amount and the
destination.

### Violations — `/admin/violations`

Filter chips: severity (All / Critical / High / Medium / Low), status (All / Open / Resolved),
and the top eight violation types, generated dynamically.
Table: Type · Severity · Account/User · Instrument · Message · Hits · Last Detected · Status.
Resolve modal: resolution type (resolved / waived / false positive) plus a note. Super-admin
additions: Flag For Review, Lock Account, Force Close Open Trades.
Bulk: Resolve, Waive, Mark False Positive. Auto-refreshes every 15 seconds.

The four severities must be immediately distinguishable from each other — this is a triage
queue, and the whole point is spotting the critical row.

### Promotion Review — `/admin/promotion-reviews`

The monthly queue of accounts awaiting manual phase promotion.

### Leaderboard — `/admin/leaderboard`

Full trader names, unmasked (unlike the public view).
Stat cards: Ranked Traders · Visible · Hidden · Avg Win Rate.
Table: Rank · Trader · Country · Account · Profit $ · Profit % · Win Rate · Trades · Visible.
Per-row and bulk Show/Hide, a visibility filter, and a drawer with the same action.

### Competitions — `/admin/competitions`, `/:id`, `/:id/analytics`

List table: Title · Type · Status · Start · End · Participants.
Create form: Title, Type (weekly / monthly / custom), Start and End datetime, Starting Balance,
Max Participants, Ranking Metric, Max Drawdown %, Daily Drawdown %, and a prize-pool editor
(arbitrary rank labels and prizes, add/remove/reorder).
Detail: settings — **locked once the competition has started**, except description and prizes —
plus Disqualify Entry, Correct Balance, bot-entrant management, and a link to a separate
Competition Analytics page.

Ending is automatic and time-based. The only manual action is Cancel.

### Settings — `/admin/settings`

**A single scrollable page, no tabs.** Two editors at the top — Per-Size Monthly Allocation
quotas, and Affiliate Commission Tiers — then eight grouped cards: Account Allocation ·
Challenge Workflow · Funded & Payouts · Trading Rules · KYC & Compliance · Automation & Safety ·
Affiliate Program · Security & Payment Provider (payment keys only).

Explicitly **not** here: branding (only a plain-text platform name exists; there is no logo or
colour editing anywhere in admin), notifications, announcements, and general security. Do not
add tabs for them.

Every field here changes platform behaviour for every trader. Group tightly, label
unambiguously, and make saving explicit — no auto-save.

### Access & Security — `/admin/access`

Cards for the current admin: Role · Auth Source · 2FA status.
2FA enrol and disable: QR code, secret, verification, backup codes.
Super-admin-only Security Checklist: DB-backed Admin Migration · Legacy Env Fallback · Admin
TOTP Coverage · Secret Hygiene.
A "Create Platform Admin" form — Email, Full Name, Password. It **sets the password directly**;
it is not an email invite. Say so on the form.
Admin users table: Admin · Status · 2FA · Last Login · Actions (Revoke Sessions, Reset
Password, Disable/Re-enable).

No admin-action audit log on this page. The existing Compliance Log lives elsewhere and logs
trade, violation, payout, and account events — not admin logins or setting changes.

### Platform P&L — `/admin/pnl` `[SUPER ADMIN]`

Six summary cards: Filtered Edge · Filtered Fees · Trader Win Rate · Closed Trades · Total
Traders · Funded Accounts.
One area chart: firm edge against fee revenue over the most recent closed trades.
A table of closed funded trades with saved views, density, columns, export, and a drawer.

No pass/fail donut exists anywhere in the product — do not add one.

### Challenge Models — `/admin/step-models` `[SUPER ADMIN]`

Per-model, per-phase editing of targets, drawdown limits, and time limits, plus per-size
pricing. This is the page that defines every number on the public landing page, so the
relationship between a row here and what a trader sees should be obvious.

### Command Center — `/admin/command-center` `[SUPER ADMIN]`

Three chip-selected queues, each with summary cards, queue-specific filters, the full
saved-views toolbar, and a side drawer offering the same actions individually:

1. **Account Recovery Queue** — bulk Restore Active · Restore + Reset · Replace · Lock · Clear
   Review Flag · Extend Days · Force Close Trades
2. **Trader Control Queue** — bulk Ban · Unban · Revoke Sessions · Approve KYC · Reject KYC ·
   Manual Account
3. **Money and Risk Queue** — bulk Flag Payout · Unflag Payout · Approve Payout · Reject
   Payout · Waive Violation

Refreshes live over a socket. Revoke Funded is deliberately **not** here — it is single-account
only, on Account Detail.

This is the most dangerous screen in the platform: bulk irreversible actions on real accounts
and real money. Every confirmation must state the action, the count, and what cannot be undone.

### Account Detail — `/admin/accounts/:accountId`

Reached from Violations, Command Center, and Funded — **not** linked from the Challenges table.

Five summary cards, an Account Snapshot, a per-account Violations table, and an Automation
Action History.

This page holds the **full lifecycle action set**: Force Pass · Breach · Lock · Extend (with a
configurable number of days, unlike the fixed 14 on the Challenges modal) · Restore Active ·
Restore + Reset · Replace · Revoke Funded · Clear Review Flag.

### Support & Appeals Center — `/admin/support-appeals-center`

**Standalone, and it renders with no admin sidebar.** Reached only from the top bar icon. Keep
that: it is a focused work surface.

Six sections:

1. **Support Tickets**
2. **Live Chat** — four KPI cards (Open · Pending · Needs Attention · Messages 24h), a plain
   search-and-status toolbar (no saved views, columns, density, or export), a conversation list,
   a message thread, and a reply box, updating in real time. **No multi-select and no bulk
   actions** here.
3. **Breach Appeals Queue** — where trader disputes land
4. **Notification Center** — a composer and log
5. **Compliance Log** — trade, violation, payout, and account-activity events
6. **ToS & Agreement Tracking**

---

## Do not

- Do not build a branding, notifications, announcements, or general-security tab in Settings.
- Do not add bulk approve/reject/flag to the Payouts page.
- Do not add a pass/fail donut chart anywhere.
- Do not add an activity feed or quick-action row to the Dashboard.
- Do not reproduce a non-functional notification bell.
- Do not give the Support & Appeals Center a sidebar.
- Do not let any bulk destructive action fire without a confirmation naming the count.
- Do not show the three super-admin items to a plain admin.
