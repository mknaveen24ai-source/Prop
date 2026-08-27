# Surface 05 — Public Pages

> Paste `00-PLATFORM-CONTEXT.md` and your theme before this file.

Five public surfaces beyond the landing page: Transparency, Leaderboard, Competitions,
Trader Profile, and the legal pages.

**Shared chrome:** these pages use a minimal public nav — logo (back to `/`) and a theme
toggle — not the landing page's full navigation. Keep it consistent across all of them.

**Architecturally important:** Leaderboard, Competitions, Competition Detail, and Trader
Profile each render a chrome-less content component that is **reused inside the trader
dashboard**. Build each page as an outer shell plus an inner content block that works with no
surrounding chrome at all.

---

## 1. Transparency — `/transparency`

The trust anchor of the entire site. A prospective trader who does not believe the payout
claims comes here, and if this page is thin the sale is lost. Treat it as a public financial
report, not a marketing page.

A seven-tab dashboard. Overview data auto-refreshes every 60 seconds.

### Tab 1 — Overview

Eight KPI cards: Total Revenue · Annualized Run Rate · Total Payouts · Largest Single Payout ·
Active Traders · Funded Traders · Pass Rate · Funded Trader AUM.

### Tab 2 — Revenue

Date-range pills, plus a combination bar-and-line chart.

### Tab 3 — Evaluations

Three KPI cards, then a funnel — Started → Phase 1 → Phase 2 → Funded — then a pass-rate-by-
model bar chart. The funnel is the most scrutinised graphic on the site: a trader is deciding
whether the evaluation is winnable. Label absolute counts as well as percentages.

### Tab 4 — Traders

Date-range pills plus a combination chart.

### Tab 5 — Funded

A dual-axis line chart: funded account count against capital under management.

### Tab 6 — Payouts

Two KPI cards, then a paginated **anonymised** table: # · Trader · Amount · Method · Date.
Trader identity is masked here — that masking is deliberate, do not "improve" it by showing
full names.

### Tab 7 — Activity

A live activity feed plus a Top Performers list.

### States

Every tab can legitimately be empty on a young platform. An empty chart must read as "no data
yet", never as a broken render, and never as a flat zero line implying failure. Do not
generate sample data to fill a chart.

---

## 2. Public Leaderboard — `/leaderboard`

The top 20 active funded accounts, ranked.

Columns: rank · name · country · account size · Trader/Account ID · Profit % · Profit $.

- Medal treatment for the top three, inline in the list. **There is no separate podium
  section** — do not add one.
- No time-period filter, no account-type filter, no charts. This page is deliberately spare.
- Each row links to that trader's public profile.

---

## 3. Competitions — `/competitions` and `/competitions/:slug`

### List

One card or row per competition: title, status badge (`Upcoming` / `Live` / `Completed` /
`Cancelled`), date range, starting balance, entry fee, and participants against maximum.

The four statuses need genuinely distinct treatments — a live competition and a cancelled one
should not be distinguishable only by reading the word.

### Detail

- **Header** — title, description, date range
- **Rules card** — Starting Balance · Max Drawdown · Entry Fee · Participants
- **Prize Pool** — a flat list of admin-configured rank labels and prizes. It is **not** a
  fixed table of amounts; the labels are arbitrary text set per competition, so the layout
  must tolerate anything from three entries to thirty.
- **Participation card** — join status and current rank, plus a Join button that is **KYC-
  gated**. An unverified trader gets a route to KYC, not a disabled button with no explanation.
- **Prize Voucher claim card** — shown to winners. Redeemable at checkout for a free challenge.
  This is the reward moment of the whole feature; give it real presence.
- **Leaderboard** — rank (medal icons for the top three), trader name including `DEMO` and
  `DISQUALIFIED` tags where they apply, country, Profit %, Profit $. Auto-refreshes every 15
  seconds. Rows link to public trader profiles.

Competitions **end automatically** on their schedule. There is no manual "End" action — only
Cancel, and that is admin-side. Do not design an end button.

---

## 4. Trader Profile — `/trader/:id`

A public, standalone profile linked from leaderboard and competition rows. Shows that trader's
public performance record. Since it is public, it shows only what the trader has consented to
expose — no email, no document details, no account balances beyond what the leaderboard
already publishes.

---

## 5. Legal pages

Four static pages, no API calls, each an accordion of sections:

- `/terms` — Terms of Service
- `/privacy` — Privacy Policy
- `/refund-policy` — Refund Policy
- `/cookie-policy` — Cookie Policy

These are read by people looking for a specific clause, and occasionally by a regulator.
Priorities: a navigable section index, deep-linkable headings, generous line length control,
and legibility over personality. They should be pleasant to read but must not restyle the
content into something that obscures it.

---

## Do not

- Do not fabricate chart data to make an empty Transparency tab look populated.
- Do not de-anonymise the public payouts table.
- Do not add a podium to the leaderboard.
- Do not add filters or charts to the leaderboard.
- Do not design a manual "End Competition" control.
