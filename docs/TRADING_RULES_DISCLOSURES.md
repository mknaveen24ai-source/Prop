# Trading rule disclosures

Behaviours the engine implements that a trader would not infer from the platform
UI, and that must therefore appear in the published trading rules. Both were
raised by the 2026-08-15 audit (M-06, M-08). Neither is a bug — each is a
deliberate house rule. The finding is that they are **undisclosed**, and an
undisclosed rule discovered from a fill is a dispute the firm loses.

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

---

## Where these need to appear

- The public challenge-rules page (`frontend/src/pages/ChallengeRules.jsx`)
- The terms accepted at checkout
- Any PDF rulebook sent to funded traders

Keep the numbers here in step with `platform_settings`: `min_hold_seconds`,
`slippage_simulator_enabled`, `slippage_max_pips_adverse`. If an admin changes
those, this document and the published rules are both stale.
