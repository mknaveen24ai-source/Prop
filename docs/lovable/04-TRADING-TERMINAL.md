# Surface 04 — Trading Terminal

> Paste `00-PLATFORM-CONTEXT.md` and your theme before this file.
> This is one tab of the trader dashboard (`03-TRADER-DASHBOARD.md`), but it is the core
> product surface and the most complex screen in the platform. Build it on its own.

A trader lives here for hours. Every design decision should favour **density, glanceability,
and not-misreading-a-number** over spaciousness. But density is not clutter: the things that
can end the account — drawdown, floating P&L, days left — must be findable without hunting.

---

## 1. Layout, top to bottom

1. **Header** — section title plus a live **price-feed health pill**, polled every few
   seconds, showing one of: `Live` / `Degraded` / `Delayed`. A trader must never place an
   order believing prices are live when they are not, so this cannot be subtle.
2. **Risk warning banner** — dismissible, and able to stick to the top when the trader scrolls.
3. **Account selector** — pill buttons, one per trading account.
4. **Instrument ticker** — an auto-scrolling marquee of bid/ask per instrument, with a
   pinnable watchlist. It pauses on hover and on touch, so a trader can actually read it.
5. **Empty / locked / loading states** — see section 5.
6. **The main two-column split** (below).
7. **Terminal-state cards** — full-width Passed / Failed / Expired messages that replace the
   trading interface entirely when the account is over.

### The main split

Two columns, resizable by dragging, constrained between roughly half and most of the width,
and the chosen ratio persists across sessions.

**Left column, in order:**

- Simulated-trading disclaimer
- **Balance bar** — six figures in a row: Balance · Floating P&L · Floating Balance · Profit %
  · Drawdown % · Days Left. These update continuously. Fix their widths so the row does not
  jitter as digits change.
- **Profit-target gauge** — progress toward this phase's target
- **Drawdown-risk gauge** — how much of the drawdown allowance is consumed. **Its severity
  levels must be visually distinct from one another**, not just from "safe". In the current
  build medium and high risk render identically, which means a trader cannot tell a warning
  from an emergency — that is the single most important bug this rebuild fixes.
- **Candlestick chart** — the tallest single element in the column, synced to the selected instrument and the active
  theme
- **Phase countdown**
- **Positions & Orders table** (section 3)
- **Closed Trades & History** (section 4)

**Right column** — the order panel, sticky so it stays reachable while the left column
scrolls.

---

## 2. Order panel

The highest-stakes component in the product. A misread here costs the trader their account.

Top to bottom:

1. **Market open/closed banner.** Weekend and rollover blackout windows are computed on the
   client, so this can say "market closed" while the rest of the page still shows prices.
   State clearly which it is and when it reopens.
2. **Instrument select**
3. **Bid / Ask / Spread card** — live. The two prices are the largest figures in the panel.
4. **Market / Pending toggle**
5. **Lot Size**, **Stop Loss**, **Take Profit** inputs
6. **Live risk/reward calculator** — recomputes as SL and TP change. Show the risk in account
   currency, not just a ratio; "1:2" means less to a trader than "risking $340".
7. **Pending-order fields** (only in Pending mode) — a four-type grid (buy limit, sell limit,
   buy stop, sell stop), an order price, and an optional **OCO sibling order**
8. **Submit** — in Market mode, two buttons, Buy and Sell, **each displaying its live price**.
   In Pending mode, a single `Place {TYPE}` button.
9. **Account summary footer** — the constraints that apply to the order about to be placed

Requirements:

- Buy and Sell must be impossible to confuse, and must not rely on colour alone.
- Validate before submit — lot size against the per-$1K limits, SL/TP against the current
  price, order value against remaining drawdown headroom. Explain a rejection in terms of the
  rule it breaks.
- Prices tick constantly. A button label that changes under the cursor is a real hazard;
  handle the case where the price moves between render and click.
- Leverage is unlimited and positions reserve no margin, so the same lot size means
  different risk on different instruments. Surface that.

---

## 3. Positions & Orders

**One unified, filterable table** — not separate tables for open and pending. Filter tabs:
`All` / `Open` / `Pending`.

Columns: Symbol · Type · Lots · Open/Target price · Current price · SL · TP · P&L · Actions.

Actions differ by row type:

- *Open position* — Modify · Partial Close · Close · Move to Breakeven
- *Pending order* — Modify · Cancel

**Modify and Partial Close expand inline within the row** rather than opening a dialog. Give
these the same care as a modal: labelled inputs, validation, a clear confirm and cancel. An
expanded row must not push the rest of the table into confusion about which row it belongs to.

**Batch actions** across selected rows: Close Winners · Close Losers · Breakeven Winners.
These are irreversible and act on real money — confirm them, and state exactly how many
positions and what net P&L will be realised.

P&L is signed, live, and the column a trader stares at. Make it the strongest column in the
table.

---

## 4. Closed Trades & History

A separate paginated table below the open positions.

Columns: Symbol · Type · Lots · Open Price · Close Price · Reason · P&L.

- `Reason` is why the trade closed — manual, stop loss, take profit, or a rule enforcement.
  Enforcement closes are the ones a trader will dispute later, so make them unmistakable.
- CSV export, including timestamps.
- A `Repeat Last Trade` action.

---

## 5. States

This screen has more non-trading states than trading ones. Each needs a real design:

| State | What the trader sees |
|---|---|
| Loading | Skeleton the balance bar and tables. Never render a zero balance as if it were real. |
| No account | A route to buy a challenge. |
| Account locked | Why it locked, and what happens next. Trading controls gone, not just disabled. |
| Market closed | Order entry disabled with the reopen time. Positions and history stay readable. |
| Feed degraded / delayed | Prominent, persistent. Order entry still works but the trader knows the risk. |
| Feed down | Order entry disabled. Do not show stale prices as live. |
| Phase passed | Full-card success, with what happens next (admin review, then the next phase or funding). |
| Phase failed | Full-card, factual, no cheerfulness. Route to Appeal and to buying again. |
| Expired | Full-card, distinct from failed — they ran out of time, they did not breach. |
| Quota closed | Cannot buy a replacement yet; countdown to the next monthly release. |

---

## 6. Responsive

Below the wide breakpoint the two-column split collapses to a single column. The order panel
must not end up below a full-height chart and two tables — on narrow screens, promote it: either
pin it as a sheet the trader can pull up, or move it directly under the balance bar.

The chart and both tables scroll horizontally inside their own containers. The page body never
scrolls sideways.

---

## 7. Do not

- Do not present medium and high risk with the same treatment.
- Do not rely on colour alone for buy/sell, gain/loss, or risk severity.
- Do not show a price without knowing it is current.
- Do not split Positions and Orders into two tables.
- Do not turn the inline modify/partial-close forms into modals.
- Do not let batch close actions fire without confirmation.
- Do not omit the simulated-trading disclaimer.
