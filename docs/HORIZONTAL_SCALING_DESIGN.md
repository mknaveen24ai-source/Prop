# Horizontal Scaling — Trade Index Design

**Status:** implemented for the split-role topology; validate on staging before
enabling it for production. Updated 2026-08-25.

---

## The problem

`backend/utils/tradeIndex.js` keeps every open trade, pending order and account
in process memory. It is why the engine reaches p99 ~11.5ms on a 100K-trade
run: the hot path does no I/O at all. It is also the reason exactly one
`ROLE=engine` process owns that index.

The unsafe historical setup was running two all-in-one instances against the
same database. That must still never be done. The supported topology is one
engine, one or more `ROLE=api` nodes, and one or more `ROLE=gateway` nodes.
API-originated opens, pending orders, modifications and closes are now published
on Redis channel `propfirm:trade-index:v1`; the engine applies them immediately.
The 30-second reconcile remains the recovery path for a missed Pub/Sub message.

Run two `ROLE=all` instances against the same database and:

- Both build a full index, so each holds a **stale** view of trades the other
  opened or closed.
- Both run the interval sweeps (SL/TP, drawdown, challenge engine). The
  session-level advisory lock in `utils/advisoryLock.js` is what currently stops
  that, and it works — but see the PgBouncer note below.
- Floating PnL is tracked per-index, so `getFloatingPnl(accountId)` disagrees
  between instances.

Trade *closes* are already safe: every close takes
`SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction (see
`services/tradeEngine.js` and `test/concurrentClose.test.js`). Postgres
guarantees exactly one winner across any number of instances. **This matters
more than the original scaling proposal credited** — the correctness floor is
already in place, and what is missing is index freshness, not double-spend
protection.

---

## Correction to the original proposal

The source analysis proposed mirroring `tradeIndex.js` into Redis: a HASH per
trade, SETs for the instrument and account indexes, pub/sub for invalidation.

**That will not work as written.** The index API is *synchronous* and sits
directly in the tick's scan loop:

| Function | File:line | Returns |
|---|---|---|
| `getTradesByInstrument` | [tradeIndex.js:399](../backend/utils/tradeIndex.js#L399) | a Map, not a Promise |
| `getPendingByInstrument` | [tradeIndex.js:403](../backend/utils/tradeIndex.js#L403) | a Map |
| `getTrade` | [tradeIndex.js:407](../backend/utils/tradeIndex.js#L407) | an object |
| `getAccountEntry` | [tradeIndex.js:411](../backend/utils/tradeIndex.js#L411) | an object |

`runTick` calls these inside a tight `for` loop over every trade on every
changed instrument. Making them async would:

1. Ripple through all 1,647 lines of `services/tradeEngine.js`.
2. Put a network round trip inside the scan loop — turning a sub-millisecond
   in-memory scan into thousands of sequential Redis calls.
3. Erase the exact latency win the index exists to provide.

The float-detect/Decimal-confirm design depends on the scan being cheap enough
to run over *every* candidate. Remote reads break that premise.

---

## Recommended architecture

**Keep the local in-memory index as the synchronous read path on every
instance. Use Redis only to propagate mutations.**

```
                    ┌─────────────────────────┐
   price tick ─────▶│  instance A             │
                    │  local index (sync)     │──┐
                    └─────────────────────────┘  │  publish
                                                 ▼  trade:opened/closed/modified
                                          ┌─────────────┐
                                          │ Redis pub/sub│
                                          └─────────────┘
                                                 │
                    ┌─────────────────────────┐  │ subscribe
   price tick ─────▶│  instance B             │◀─┘
                    │  local index (sync)     │
                    └─────────────────────────┘
                              │
                              ▼
                    Postgres (FOR UPDATE SKIP LOCKED)
                    — the actual correctness boundary
```

### 1. Mutation events, not remote reads

Every place that already calls `tradeIndex.addTrade` / `removeTrade` /
`syncOpenedTrade` / `syncClosedTrade` also publishes a small event:

```json
{ "type": "trade.closed", "tradeId": "...", "accountId": "...",
  "instrument": "EURUSD", "pnl": -500, "origin": "instance-a", "seq": 41822 }
```

Each instance subscribes and applies the delta to its own local maps, ignoring
events it published itself (`origin`). Reads stay synchronous and local.

### 2. Postgres remains the correctness boundary

Redis is a **cache-coherence** mechanism here, not a source of truth. A dropped
or late message costs freshness, never money — the close still has to win
`FOR UPDATE SKIP LOCKED` against the real row. Design every consumer so a
missed message degrades to "this instance acts on slightly stale data and its
transaction loses the lock", never to "this instance writes a wrong balance".

### 3. Drift recovery

`fullReconcileFromDB()` ([tradeIndex.js:447](../backend/utils/tradeIndex.js#L447))
already rebuilds the index from Postgres. Reuse it:

- on startup, before `isReady()` flips true (already the case),
- when a monotonic `seq` gap is detected on the pub/sub stream,
- on a slow timer (every few minutes) as a backstop.

The existing `getLastReconcileAt()` is already surfaced through
`/api/admin/system-health`, so reconcile freshness is observable from day one.

### 4. Singleton sweeps, not distributed ones

Do **not** try to shard the interval sweeps (drawdown, challenge engine,
competition engine). Elect one instance to run them. `utils/advisoryLock.js`
already does exactly this and needs no change.

**PgBouncer interaction:** those are *session-level* advisory locks. Under
transaction pooling each statement can land on a different backend, so the lock
would be taken on one connection, the job would run on others, and the unlock
would miss — leaking the lock and silently disabling the mutual exclusion. This
is already handled: `advisoryLock.js` runs on `directPool`, which bypasses the
pooler (see `backend/db.js`). Preserve that when this work lands.

### 5. Floating PnL

`_floatingPnl` is per-instance and derived from the local index. Once trades for
one account can be scanned by different instances, the per-account total is only
correct on the instance that owns that account's sweep. Two options, in
preference order:

1. **Account affinity** — hash `accountId` to an instance for equity
   broadcasting. Simple, keeps the sum local and exact.
2. Redis HINCRBY on a shared counter. Rejected for now: float accumulation in
   Redis reintroduces exactly the precision problem `pnlCalculator.js` exists to
   avoid.

---

## What must be true before starting

- [ ] Engine equivalence run completed for `ENGINE_MODE=event` (still outstanding
      from the 2026-08-14 engine work). Do not layer distribution on top of an
      unverified engine.
- [ ] PgBouncer enabled and observed under load (`--profile pgbouncer`), since
      multi-instance is what makes it worth having.
- [ ] `propfirm_engine_tick_duration_seconds` and pool gauges trending in
      Prometheus, so the before/after is measurable rather than asserted.

## Sequencing

| Step | Work | Risk |
|---|---|---|
| 1 | Publish mutation events; no subscriber. Verify volume and shape. | very low — additive |
| 2 | Subscribe behind `INDEX_SYNC=off\|shadow\|on`. In `shadow`, apply to a **copy** and log divergence against a periodic reconcile. | low — no behaviour change |
| 3 | Flip to `on` with one instance. Divergence should be zero. | low |
| 4 | Add a second instance behind the load balancer, sweeps still singleton. | medium |
| 5 | Account affinity for equity broadcast. | medium |

Step 2's shadow mode is the important one: it answers "would the distributed
index have agreed with the database?" without any production risk. Do not skip
it.

## Explicitly out of scope

- Replacing Postgres advisory locks with Redis locks. The Postgres ones are
  correct and already carved out from the pooler; swapping them trades a solved
  problem for a distributed-lock-correctness problem.
- Redis as a source of truth for trades. It is a cache-coherence bus here.
- Sharding trades across instances by instrument. Attractive on paper, but it
  makes per-account equity a cross-shard aggregate, which is worse than the
  problem it solves.

---

## Current capacity, for reference

The single-instance design is comfortable to roughly 3,000 concurrent traders.
Below that, this work is not the constraint and should not be started — the
observability added alongside it (`/api/admin/system-health`, the Prometheus
gauges) is what should tell you when it becomes one. Watch
`propfirm_db_pool_waiting` and the engine tick histogram; sustained queueing on
the pool is the first honest signal.
