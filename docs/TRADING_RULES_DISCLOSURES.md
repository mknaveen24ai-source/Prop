# Trading rule disclosures

> **STATUS: both findings below are RESOLVED — by changing the behaviour, not by
> disclosing it.** See "How this was resolved" under each. This document is kept
> rather than deleted because it is the audit trail: it records what the engine
> used to do, why, and what was decided instead. If either behaviour is ever
> reintroduced, the disclosure obligation described here comes back with it.

Behaviours the engine implements that a trader would not infer from the platform
UI, and that must therefore appear in the published trading rules. Both were
raised by the 2026-08-15 audit (M-06, M-08). Neither is a bug — each is a
deliberate house rule. The finding is that they are **undisclosed**, and an
undisclosed rule discovered from a fill is a dispute the firm loses.

The 2026-08-24 examination escalated both: the second was not merely undisclosed
but publicly *denied* ("zero artificial latency or slippage"), and it concluded
that "your stop loss does not work for the first minute" is not a sentence that
can be disclosed into acceptability — a trader who reads it and signs up anyway
still disputes the first time it costs them an account, and is right to.

---

## 1. Stop loss and take profit are suppressed during the minimum hold window

**Where:** `backend/services/tradeEngine.js`, `checkSLTP` — the `minHoldSeconds`
check (admin-configurable, default **60 seconds**).

**What actually happens.** A position younger than `minHoldSeconds` is skipped
entirely by the SL/TP checker. It is not queued and it is not filled later at
the level:

- Price touches your stop at second 10 → nothing happens.
- Price is still through the stop at second 61 → it closes **at the price then**,
  which may be far worse than the stop.
- Price came back before second 61 → the stop **never fills at all**, and the
  position stays open as if the level had never been reached.

**Why it exists.** It prevents sub-minute scalping of the simulated feed, where
an SL/TP pair a few pips wide is a way to farm spread noise rather than trade.

**What must be published.** That stop loss and take profit levels are *not
active* for the first N seconds of a position, and that a level crossed inside
that window neither fills at the level nor is remembered. Traders should be told
to size the hold window into their strategy, not to expect a stop to protect
them immediately after entry.

**Alternative, if you would rather not disclose it:** honour the stop at the
stop price once the window expires, by recording that the level was crossed and
filling at the recorded level. That is a behaviour change, not a doc change, and
it costs the firm money in exactly the scalping case the rule exists to prevent.

### How this was resolved

The alternative was taken. Migration `044_deferred_sl_tp_trigger.js` adds
`trades.pending_close_price` / `pending_close_reason` / `pending_close_at`. A
level crossed inside the hold window is now recorded (`checkSLTP`'s recording
branch, and `recordDeferredTriggers` on the event path) and filled **at the
recorded level** once the window expires — regardless of where price has gone
since, including all the way back through it.

The columns live on the row rather than in an engine-local map so a restart
cannot evaporate a trader's stop. First crossing wins: the
`pending_close_price IS NULL` guard makes the write idempotent across ticks.
Moving or clearing a level (`routes/trades/modify.js`) discards the recorded
crossing, so a stale trigger cannot fire against a level that no longer exists.

The minimum-hold window still prevents a position being *closed by hand* inside
it, which is the anti-scalping rule it exists for. It no longer means the
protective order is absent. Covered by four tests in
`backend/test/tradeEngine.test.js`, including the examination's scenario T5.

---

## 2. Simulated slippage is always adverse, on both entry and exit

**Where:** `backend/routes/trades/open.js` (entry) and
`backend/routes/trades/close.js` (exit), gated by `slippage_simulator_enabled`
and sized by `slippage_max_pips_adverse`.

**What actually happens.** When the simulator is on, a random slippage of
`0 … slippage_max_pips_adverse` pips is applied, and it is **always against the
trader**:

| | Applied at entry | Applied at exit |
|---|---|---|
| BUY | fills **higher** than quoted | closes **lower** than quoted |
| SELL | fills **lower** than quoted | closes **higher** than quoted |

It is never favourable in either direction. A round trip therefore pays the
slippage cost twice, on top of the spread and commission.

**Why it exists.** Real execution has slippage, and a simulator that only ever
helped the trader would make the evaluation easier to pass than live trading.

**What must be published.** That slippage simulation is enabled, that it is
one-directional (adverse only), that it applies to both the open and the close,
and the maximum pip value in force. A trader comparing their fill to the quoted
price will otherwise conclude the platform is misquoting them.

**Alternative:** make it symmetric — draw from `-max … +max` rather than
`0 … max`. That models real execution more honestly and removes the disclosure
burden, at the cost of a small expected-value giveaway versus the current model.

### How this was resolved

The alternative was taken. Both draws are now `(Math.random() * 2 - 1) * max`
(`routes/trades/open.js`, `routes/trades/close.js`), so slippage moves in the
trader's favour as often as it moves against them.

The stored setting keeps its `slippage_max_pips_adverse` name to avoid a
settings migration — it is now the **half-width of a symmetric band**, not a
direction. The admin screen labels it `Max Slippage ± (pips)` accordingly.

`trades.slippage_pips` is therefore **signed**: positive is against the trader,
negative in their favour. Anything aggregating it must not assume `>= 0`;
`services/analytics/risk.js` already wraps it in `ABS()`, and the trader's fill
toast reports a negative draw as "positive slippage".

---

## Where these need to appear

- The public challenge-rules page (`frontend/src/pages/ChallengeRules.jsx`)
- The terms accepted at checkout
- Any PDF rulebook sent to funded traders

Keep the numbers here in step with `platform_settings`: `min_hold_seconds`,
`slippage_simulator_enabled`, `slippage_max_pips_adverse`. If an admin changes
those, this document and the published rules are both stale.

The published rules are rendered from live settings by `buildRuleColumns()` in
`frontend/src/pages/ChallengeRules.jsx`, which `PublicRules.jsx` imports rather
than reimplements — so the public `/rules` page and the in-app rulebook cannot
drift into describing the same rule two different ways.
