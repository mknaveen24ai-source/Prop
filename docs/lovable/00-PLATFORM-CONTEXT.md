# Platform Context — paste this before every other prompt

You are building the frontend for a **proprietary trading firm** ("prop firm") platform.
Read this preamble before the surface spec that follows it. Everything here is a real product
mechanic, not an example — do not substitute different numbers, invent extra rules, or drop
rules you find inconvenient to design around.

---

## 1. What the business actually does

Traders do not deposit trading capital. Instead:

1. A trader **buys a challenge** — a paid evaluation account, funded with simulated money
   trading on live market prices.
2. They must hit a **profit target** within a **time limit** without breaching **drawdown
   limits**. Depending on the model they chose, this repeats for one, two, or three phases.
3. Pass every phase and they get a **funded account** backed by the firm's real capital.
4. They trade it and **request payouts**, keeping their share of the profits.
5. Break a drawdown rule at any point and the account is **breached** — closed. They may buy
   a new challenge when slots reopen.

The firm's revenue is challenge fees plus its share of funded-trader profits. That means the
product has two audiences with opposite emotional needs, and the UI must serve both:
prospective buyers who need to trust the rules are fair, and existing traders who need to see
exactly how close they are to breaching one.

## 2. Glossary — use these words, they are the product's vocabulary

| Term | Meaning |
|---|---|
| **Challenge** / **Evaluation** | The paid test account. Simulated balance, live prices. |
| **Model** | How many phases the challenge has: 1-step, 2-step, or 3-step. |
| **Phase** | One stage of an evaluation, with its own target and time limit. |
| **Account size** | The notional balance being evaluated — from $5,000 to $400,000. |
| **Profit target** | The percentage gain needed to pass a phase. |
| **Drawdown** | How far equity has fallen from its high-water mark. The thing that kills accounts. |
| **Daily drawdown** | The same, measured within a single trading day. |
| **Trailing drawdown** | A drawdown floor that rises as the account profits and never falls back. |
| **Breach** / **Breached** | A rule was broken; the account is closed. Not "failed" — failing is running out of time. |
| **Funded** | Passed every phase; now trading the firm's real capital. |
| **Profit split** | The trader's percentage share of funded profits. |
| **Payout** | A withdrawal of the trader's share. |
| **Consistency rule** | A cap on how much of total profit can come from one day. |
| **Qualifying trading day** | A day that counts toward the minimum-days requirement. |
| **KYC** | Identity verification. Gates buying larger accounts and gates payouts. |
| **Slot** / **Allocation** | Each account size has a capped number of accounts released per month. |
| **Voucher** | A prize code won in a competition, redeemable for a free challenge. |

Never use "deposit", "investment", "returns", "trading account funded by you", or anything
implying the trader's own money is at risk in the market. It is not, and the wording is a
compliance matter.

## 3. The frozen numbers

Treat every figure below as fixed. They are published in the trader's terms.

**Account sizes** — $5,000 · $10,000 · $25,000 · $50,000 · $100,000 · $200,000 · $400,000.
Seven sizes, available across all three models. $25,000 is the default/recommended size.

Size tier labels, in ascending order: Advanced · Standard · Pro · Elite · Enterprise ·
Institutional. (The $5,000 tier is labelled "Advanced" — this is intentional, do not
"correct" the ordering.)

**Profit targets and time limits**

| Model | Phase 1 | Phase 2 | Phase 3 | Time limit |
|---|---|---|---|---|
| 1-step | 16% | — | — | 45 days |
| 2-step | 10% | 8% | — | 45 days per phase |
| 3-step | 8% | 6% | 6% | 45 days per phase |

**Risk rules — identical on every model, every phase, evaluation and funded alike**

- Maximum drawdown: **4%**, trailing. The floor only ever rises with profit.
- Daily drawdown: **2%**. On a funded account, hitting it locks the account.
- Consistency rule: no single day may be more than **15%** of total profit. Breaking it is a
  soft hold, not a breach — the trader keeps trading until the ratio comes down, then passes
  automatically.
- Minimum qualifying trading days: **5** per evaluation phase. A day only qualifies once the
  account is up at least **0.75%** of starting balance that day.

**Leverage** — UNLIMITED. Positions reserve no margin and there is no cap on trade size
relative to account size. The only structural limits are the number of open positions
(`max_open_positions`, default 10) and a per-order notional ceiling that exists purely as a
fat-finger guard. Risk is governed by the drawdown rules, not by position size.

**Funded stage**

- Profit split: **100%** to the trader. The firm's revenue is the entry fee, which is itself
  refunded on the trader's first payout.
- Payout cadence: **weekly**.
- Before the *first* payout only: at least **10** qualifying trading days and **6%** net
  profit on the account. No lock-up after that.
- Minimum payout request: **$50**.
- Drawdown lock-in: once funded equity reaches **2%** above starting balance, the drawdown
  floor locks there permanently.
- Scaling: every new **6%** net-profit milestone doubles the account's risk-capacity
  multiplier, compounding.

**Entry price** — challenges start from **$4**. Price varies by size and model and is always
fetched live, never hardcoded.

**Availability** — most sizes are open continuously. Where a size carries a capacity limit it
is a fixed pool, NOT a monthly one — there is no monthly reset in the code, so do not promise
one. When a size fills, it
shows as full and reopens automatically at the start of the next month. A trader may hold one
active evaluation and one funded account at a time.

## 4. Lifecycle state machine

```
Visitor → Register → (KYC) → Buy challenge → Phase 1 ─pass→ Phase 2 ─pass→ Phase 3 ─pass→ Funded
                                                │              │              │            │
                                             breach /        breach /       breach /    breach → closed
                                             expired         expired        expired         │
                                                │                                        Payout request
                                          Buy again / Appeal                                 │
                                                                                    Admin review → Paid
```

Every one of those states needs a real screen state. The unhappy paths — breached, expired,
locked, quota-closed, KYC-rejected, payout-ineligible — are not edge cases here; they are the
majority outcome for most traders, and they are where design usually fails this product.

## 5. Roles

- **Trader** — sees only their own data. Has a dashboard with a sidebar of tabs.
- **Admin** — separate login, separate panel, separate session entirely from the trader app.
  Reviews KYC, monitors risk, approves payouts.
- **Super admin** — an admin plus three extra areas: Platform P&L, Command Center, and
  Challenge Models.

The trader app and admin app share a visual language but no navigation. Do not build a single
nav that switches between them.

## 6. Conventions that hold across every surface

- **Payment is always a hosted redirect.** There is no card-entry form anywhere in this
  product. Checkout ends by leaving the site. Never design one.
- **Every number is live.** Prices, slot counts, balances, payout totals, leaderboard
  standings — all fetched, all capable of being zero, stale, or unavailable. Every figure
  needs a loading state and an empty state, and "empty" must not look broken.
- **Money and percentages are scannable figures**, not prose. They get aligned, consistent
  decimal precision, and enough visual weight to be read at a glance in a table.
- **Gain and loss need a consistent, unambiguous encoding** used identically everywhere, and
  it must not be color alone — a trader glancing at a red number needs the sign and the
  context to agree.
- **Risk severity has four levels** — low, medium, high, critical — and they must be visually
  distinguishable from each other, not just from "fine". A trader at 89% of their drawdown
  limit must not see the same treatment as one at 40%.
- **Simulated-trading and risk disclaimers are mandatory** on any surface showing trading
  activity or performance. They are legally required, so give them a real place in the layout
  rather than burying them.
- **Both a light and a dark presentation are required**, and the trading surfaces are used
  for hours at a time.
- Responsive down to a phone. Breakpoint behavior that matters: wide layouts cap their
  content width, two-column trading layouts collapse to one column, the trader sidebar
  becomes a bottom tab bar, the admin sidebar becomes an overlay, and multi-column grids go
  to a single column.
- Accessibility is not optional: keyboard-reachable controls, real focus states, labelled
  form fields, and tables that a screen reader can navigate.

## 7. Do not invent

- Do not invent testimonials with names, avatars, handles, photos, or dollar figures.
- Do not invent payout totals, trader counts, or "as seen in" logos.
- Do not invent regulatory claims, licences, broker names, or awards.
- Do not invent rules that sound plausible for a prop firm but are not listed above.
- Do not add a countdown timer, a "12 people viewing this" widget, or any other fabricated
  scarcity. Real scarcity already exists in the monthly slot allocation — use that instead.

---

<<< PASTE YOUR THEME / DESIGN SYSTEM HERE >>>

---

The surface specification follows.
