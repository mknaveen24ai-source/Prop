# Surface 03 — Trader Dashboard

> Paste `00-PLATFORM-CONTEXT.md` and your theme before this file.
> The Trade tab is large enough to have its own file — see `04-TRADING-TERMINAL.md`.

The logged-in trader's home. A persistent shell wrapping thirteen sections. Build the shell
first, then request sections one at a time.

---

## 1. The shell

### Sidebar

Collapsible, and the collapsed state persists across sessions. Header holds the logo mark, a
wordmark, and a "Trader Portal" sub-label; the text hides when collapsed, the mark stays. A
floating chevron toggles it.

Navigation items, in this exact order:

1. Dashboard — *badge: unread notification count*
2. New Challenge
3. Rules
4. Trade
5. Analytics
6. History
7. Competitions
8. KYC — *badge: a status dot when KYC is pending or rejected*
9. Payouts — *badge: pending payout count*
10. Affiliate
11. Live Chat
12. Appeal
13. Support

**Profile is not in this list.** It is reached from an avatar row pinned to the sidebar
footer. Keep it that way on desktop.

Badges here are **data-driven, not permission-driven** — every trader sees every item; the
badges reflect what needs their attention. A trader with rejected KYC and two pending payouts
should be able to tell that at a glance without reading labels.

### Topbar

No logo and no avatar (both live in the sidebar). Left to right:

- A **connection status** indicator tied to the live socket — connected / degraded /
  disconnected. This matters: a trader needs to know whether the prices they are looking at
  are live.
- Trader name plus a KYC status badge, clickable through to the KYC section
- Notification bell with unread count and a dropdown panel — mark-all-read and clear actions.
  *(Notifications are stored client-side only in the current build, so they do not survive a
  device change. Do not imply cross-device sync.)*
- Theme toggle
- Logout

### Announcement banner

A sticky, dismissible strip above the topbar, polled every few minutes, with four severity
variants (informational through critical). Dismissal is remembered per announcement.

### Onboarding overlay

On first login only: a seven-step full-screen walkthrough — Welcome → Complete KYC → Choose a
Challenge → Rules reference → Pass Your Challenge → Request Payouts → Ready. Step dots,
Back/Next, and a global Skip available on every step.

### Mobile

Below the tablet breakpoint the sidebar is replaced by a bottom tab bar. Thirteen items do not
fit — surface the highest-value five or six and put the rest behind a "More" sheet. **Profile
must appear as a real tab on mobile**, since the sidebar footer avatar does not exist there.

---

## 2. Dashboard Home

The screen that answers "am I okay?" in under two seconds. Ordered by urgency:

**Account switcher** — a card per account showing type, size, short account ID, and status.
A trader can hold an evaluation and a funded account simultaneously, so this is not always a
single-card decoration.

**Conditional banners, in priority order:**

- *No active account, or only failed ones* → a Start Challenge card
- *Monthly quota closed* → a warning with a four-box countdown (days / hours / minutes /
  seconds) to the next release
- *Drawdown at 75% or more of the limit* → a warning banner, escalating to a distinctly more
  severe treatment at 90%. These two must not look the same.
- *Account locked* → a locked-state card explaining why and what happens next

**KPI grid, six figures:** Current Balance · Live Equity · Floating P&L · Profit % · Trades
Today · Days Remaining. Floating P&L is signed and changes constantly — it needs a stable
layout that does not reflow as digits change.

**Challenge expiry countdown** — four boxes, live-ticking, with a distinct expired state.

**Profit-target progress bar** — Earned / Target / Remaining. Hidden entirely once funded.

**Two risk cards, side by side:**

- Drawdown bar — used vs. remaining, with the four severity levels visually distinct
- Consistency Score — a circular gauge, 0–100, comparing best-day profit against the firm's
  15% limit

**Two reference tables:**

- *Account Info* — Trader ID, Account ID, Type, Size, Starting Balance, Current Balance,
  Equity, Status
- *Rules* — Profit Target %, Max Drawdown %, Time Limit, Max Daily Trades, Min Hold Time,
  Max open positions, Profit Split %. Ends with a "Full Rules" link to the Rules
  section.

## 3. New Challenge

The in-dashboard purchase wizard. Three steps plus a confirmation.

1. **Pick a model** — 1-step / 2-step / 3-step cards showing phase count, phase-1 target,
   max drawdown, time limit, and a price range. Accompanied by a three-step "how it works"
   explainer.
2. **Pick a size** — the seven sizes, each with an availability pill (`OPEN` / `LOW` / `FULL`
   / `UNAVAILABLE`), live remaining slots, and price. **This step is KYC-gated** — an
   unverified trader is blocked above a threshold size and needs a clear route to KYC, not a
   dead end.
3. **Confirm modal** — size, target %, days, max drawdown %, and final price including any
   referral discount.

Then it creates the order and hands off to hosted payment, exactly as `/checkout` does.

## 4. Rules

A full reference for the selected account's rules — every figure that can breach the account,
stated plainly, with the dollar equivalents computed for that account size rather than left
as percentages. Ends with a "Trade Now" action into the Trade section.

This page's job is that a trader can never say they did not know. Favour completeness and
scannability over brevity.

## 5. Trade

See `04-TRADING-TERMINAL.md`.

## 6. Analytics

**Eight KPI cards:** Total Trades · Win Rate · Total P&L · Avg Hold Time · Best Trade · Worst
Trade · Discipline Score · Risk Consistency.

**Balance/equity curve** — range selector (1D / 1W / 1M / Full Challenge) plus a replay
scrubber that walks the curve forward.

**Trade-by-trade history table** — #, Date, Balance, P&L, and a per-row drawdown bar. There is
no separate drawdown chart; the per-row bar is the drawdown view.

**Win-rate breakdowns** — three groupings: by Symbol, by Weekday, by Session.

**Hour × Weekday P&L heatmap**, with a "Best Weekday Pocket" callout summarising it.

**Then four analysis sections:** Hold-Time Analytics · Best/Worst Setups · Breach Analysis
(cause, target progress, drawdown usage, days remaining) · Payout Readiness Forecast
(estimated payable amount, KYC status, and any blockers).

**Improvement suggestions** — generated coaching notes. Label them clearly as automated
analysis, not advice.

## 7. History

Paginated account history, separate from Analytics. Straightforward table with filtering and
export.

## 8. Competitions

Embeds the public competitions list and detail views inside the dashboard chrome — see
`05-PUBLIC-PAGES.md` for their contents. The difference in here is that the join action is
live and KYC-gated, and a winner sees their prize voucher.

## 9. KYC

**Status banner**, one of four: Approved · Pending · Rejected · Not Submitted. ("Not
Submitted" means no record exists. A rejected resubmission returns to Pending — there is no
separate "Resubmitted" state.)

**Upload form:**

- Country of Residence
- Document Type — Passport / National ID / Aadhaar / Driver's License / Residence Permit
- Document Number
- ID Front and ID Back uploads
- Selfie — **either** a file upload **or** a live in-browser webcam capture

The webcam capture is a full-screen live preview with Capture / Retake / Use This Photo. Treat
it as a first-class flow, not a fallback: it needs a camera-permission-denied state and a
no-camera-available state.

**Approved** → success message, form hidden. **Rejected** → the rejection reason shown
prominently, and the form reopens prefilled where possible.

## 10. Payouts

**Eligibility card** — Available Profit and Profit Share %. With no funded account, the whole
section is a gated empty state explaining what unlocks it.

**Request form** — Amount ($50 minimum, capped at available profit, with a live "you receive"
preview after the split), Payment Method (Crypto / Bank Transfer / Wise / PayPal as suggested
options), and free-text Payment Details.

**History table** — Trader ID, Account ID, Amount, You Receive, Method, Status, Requested,
Paid. A Download Statement action appears once any payout has been paid.

Gating that must be visible before the trader fills the form in: first payout requires 10
qualifying trading days and 6% net profit. Show progress toward both, not just a rejection
after submitting.

## 11. Affiliate

**Four KPI cards:** Lifetime Commission · Available Balance · Total Referrals · Paying
Referrals.

**Referral link box** with a copy button and clear copied-confirmation.

**Commission tier as a progress card** — current tier percentage and progress to the next
tier. Not a full tier table.

**Three tables:** Referrals (Name, Country, Joined, Status, Commission Generated) · Commission
Ledger (From, Order Amount, Rate, Commission, Status, Earned) · Payout History (Amount,
Method, Status, Requested, Paid).

**Its own payout request form**, which settles the entire available balance rather than taking
an amount.

## 12. Live Chat

Real-time support, distinct from the Support ticket system.

- Header: a single "{N} active" badge plus an unread sub-badge. No stat card row.
- `+ New Chat` → a subject-only form
- Conversation list: subject, status pill, last-message preview and time, unread badge
- Thread: header with subject, status, and a Close action; message bubbles (trader right,
  support left) with date separators, auto-scroll to newest, and an input that disables once
  the conversation is closed

There is **no typing indicator** — do not design one.

## 13. Support

Ticket system, HTTP-polled, separate from Live Chat.

Two tabs: `Submit Ticket` and `My Tickets`.

- New ticket: a category grid (Account Issue · Trading Problem · KYC/Verification · Payout
  Request · Technical Bug · Other), Email (only when logged out), Subject, and a Message
  requiring at least 20 characters.
- Tickets table: Ticket, Status, Date → opens a reply thread.
- Side panel: a "Submitting As" card and a Response Times table.

## 14. Appeal

For contesting a breach. Only failed or expired accounts are eligible — with none, this is a
gated empty state.

- Form: Account dropdown, a Reason grid (drawdown calculation error · price feed or slippage ·
  platform error · wrong close · unjust expiry · other), and a Description between 30 and
  2,000 characters with a live counter.
- Side panel: a four-step process explainer, and "My Disputes" as a **list** (id, status,
  reason, account, date, admin response) — not a table.

This screen is used by angry people who have just lost money. It should feel like it takes
them seriously: no cheerful illustrations, no dismissive empty states.

## 15. Profile

Reached from the sidebar footer avatar, or the Profile tab on mobile. Editable account
details. Note that traders currently have **no** self-service two-factor setup — if you add a
placeholder for it, mark it as unavailable rather than building a non-functional flow.

---

## Cross-cutting requirements

- **Every section needs four states:** loading, empty, error, and gated (blocked by KYC, by
  having no funded account, or by not holding an eligible account). The gated state must
  always name what unlocks it and link there.
- **Tables repeat constantly** — build one table with sorting, pagination, density, column
  visibility, empty state, and CSV export, then reuse it. The same goes for stat cards, status
  badges, progress bars, and drawers.
- **Every monetary and percentage figure** is a scannable aligned figure with consistent
  precision.
- **The four risk severities must be distinguishable from each other**, by more than hue.
- Simulated-trading and risk disclaimers appear on every surface showing trading activity.
- Long sessions are the norm. Both themes must be comfortable for hours.
