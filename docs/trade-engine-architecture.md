# Scale Trade Engine to 100,000+ Trades — Architecture Plan

## The Math Problem at 100K

At 100K open trades, the bottlenecks shift from DB I/O to **CPU and memory**:

```
Current approach (loop all trades every tick):
  100,000 trades × Decimal.js PnL calc (~5μs each) = ~500ms ← BLOCKS EVENT LOOP

Instrument-indexed approach (only affected trades):
  ~40 instruments, ~2,500 trades per instrument average
  Price tick changes 1-5 instruments → scan 2,500-12,500 trades
  2,500 trades × native float PnL (~0.05μs each) = ~0.125ms ← INSTANT
```

**Key insight:** A price tick from MT5 only changes prices for the instruments that moved. With instrument-indexed maps, we scan **2,500 trades per instrument** instead of 100,000.

---

## Architecture Overview

```
MT5 Price File Change (~50-200ms intervals)
       │
       ▼
   fs.watch callback
       │
       ▼
┌─────────────────────────────┐
│   In-Memory Price Cache     │  ← Component 1
│   (priceCache.js)           │
└─────────────────────────────┘
       │
       ├──▶ io.emit('price_update')     → All clients
       │
       ▼
┌─────────────────────────────┐
│   Trade Engine Worker Pool  │  ← Component 3
│   (engineWorker.js)         │
│                             │
│   Instrument-Indexed Maps:  │  ← Component 2
│   EURUSD → [trade1, trade2] │
│   XAUUSD → [trade3, trade4] │
│                             │
│   For each changed instrument:
│   ├─ Fast PnL (native float)│  ← Component 4
│   ├─ Drawdown check         │
│   ├─ Profit target check    │
│   ├─ SL/TP check            │
│   └─ Pending order check    │
└─────────────────────────────┘
       │
       ├──▶ Breaches/triggers found?
       │         │
       │         ▼
       │   ┌──────────────────┐
       │   │ Bulk DB Closures │  ← Component 5
       │   │ (main thread)    │
       │   │ Single UPDATE    │
       │   │ per account      │
       │   └──────────────────┘
       │
       └──▶ io.to(userId).emit('equity_update')  → Component 6
```

---

## Proposed Changes

### Component 1: In-Memory Price Cache

#### [NEW] `backend/utils/priceCache.js`

```javascript
// Singleton — holds latest prices, updated by watcher
const _prices = {}          // { EURUSD: {bid, ask}, XAUUSD: {bid, ask}, ... }
const _tenantPrices = {}    // Same but with spread markup applied
let _lastUpdateAt = 0

function updatePrices(prices)        // Called by watcher
function getPrice(instrument)        // O(1) lookup
function getAllPrices()               // Returns full map
function getChangedInstruments(prev, next) // Returns ['EURUSD', 'XAUUSD']
function getPriceCacheAgeMs()        // For health checks
```

**Zero DB overhead** — all engine loops read from here.

---

### Component 2: Instrument-Indexed Trade Map

#### [NEW] `backend/utils/tradeIndex.js`

> [!IMPORTANT]
> **This is the critical 100K enabler.** Instead of scanning all 100K trades on every price tick, we only scan trades for the instruments whose prices actually changed.

```javascript
// In-memory index, kept in sync via events
const _byInstrument = new Map()  // 'EURUSD' → Map<tradeId, TradeEntry>
const _byAccount = new Map()     // accountId → AccountEntry
const _byId = new Map()          // tradeId → TradeEntry

// TradeEntry (lightweight, ~200 bytes each):
{
  id, accountId, instrument, direction,
  openPrice: Number,    // native float, NOT Decimal
  lots: Number,
  commission: Number,
  stopLoss: Number | null,
  takeProfit: Number | null,
  openTimeMs: Number,
  contractSize: Number  // pre-looked-up from constants
}

// AccountEntry:
{
  id, userId, startingBalance, currentBalance, peakEquity,
  maxDrawdownPct, dailyDrawdownPct, drawdownFloor,
  profitTarget, accountType, challengeModelSlug,
  drawdownLocksAtPct, eodTrailingFloor,
  tradeIds: Set<tradeId>
}

// Mutation API (called by trade routes + reconciliation):
addTrade(trade, account)
removeTrade(tradeId)
updateAccountBalance(accountId, newBalance)
getTradesByInstrument(instrument)    // O(1) — returns the Map
getAccountEntry(accountId)           // O(1)
getTradeCount()                      // O(1)
fullReconcileFromDB()                // Every 30s safety sync
```

**Memory at 100K trades:** ~200 bytes × 100K = **~20MB** — trivial.

---

### Component 3: Worker Thread Engine

#### [NEW] `backend/workers/tradeEngineWorker.js`

> [!WARNING]
> At 100K trades with Decimal.js: **500ms CPU block per tick**. With native floats + instrument indexing: **~3-8ms per tick**. Even at ~8ms, running on the main thread is fine. Worker threads become a safety margin, not a requirement.
>
> **Decision: Start without workers, add them only if profiling shows >20ms per tick at real load.** The instrument indexing alone cuts the work by 95%.

For now, the engine runs on the **main thread** with native floats. The plan includes worker thread code as a ready-to-deploy upgrade if needed.

---

### Component 4: Fast-Path PnL Calculator (Native Float)

#### [NEW] `backend/utils/fastPnL.js`

```javascript
// CONTRACT_SIZES pre-cached as plain numbers (not Decimal)
const CS = { EURUSD: 100000, XAUUSD: 100, XAGUSD: 5000, ... }

// Hot path — called 2,500-12,500 times per price tick
// ~0.05μs per call (vs Decimal.js ~5μs = 100x faster)
function fastPnL(direction, openPrice, closePrice, lots, contractSize, commission) {
  const diff = direction === 1  // 1=buy, -1=sell (avoid string comparison)
    ? closePrice - openPrice
    : openPrice - closePrice
  return diff * lots * contractSize - commission
}

// Only used for actual trade closure (needs precision)
function precisePnL(direction, openPrice, closePrice, lots, instrument, commission) {
  // Uses Decimal.js — same as current calculatePnL()
}
```

**Benchmark: 100K calls to `fastPnL` = ~5ms. Same with Decimal.js = ~500ms.**

---

### Component 5: Bulk DB Operations

#### [MODIFY] [`routes/trades.js`](file:///e:/propfirm/backend/routes/trades.js)

Replace per-trade transactions with **bulk operations**:

```javascript
// Close 500 trades in ONE statement:
await client.query(`
  UPDATE trades SET
    status = 'closed',
    close_price = v.close_price,
    close_time = NOW(),
    demo_pnl = v.pnl,
    close_reason = $1
  FROM (
    SELECT unnest($2::uuid[]) AS id,
           unnest($3::numeric[]) AS close_price,
           unnest($4::numeric[]) AS pnl
  ) v
  WHERE trades.id = v.id AND trades.status = 'open'
`, [reason, tradeIds, closePrices, pnls])

// Single balance update per account:
await client.query(`
  UPDATE accounts SET
    current_balance = current_balance + $1,
    peak_balance = GREATEST(peak_balance, current_balance + $1)
  WHERE id = $2
`, [totalPnl, accountId])
```

**Impact: Closing 1,000 trades = 2 queries instead of 2,000.**

---

### Component 6: Real-Time Dashboard Equity Push

#### [MODIFY] [`services/priceBroadcast.js`](file:///e:/propfirm/backend/services/priceBroadcast.js)

After the engine tick, push equity updates to connected users:

```javascript
// Throttled to max 2/second per user
io.to(String(userId)).emit('equity_update', {
  account_id,
  equity,
  floating_pnl,
  current_balance,
  drawdown_used_pct,
  daily_drawdown_used_pct,
  profit_remaining,
})
```

#### [MODIFY] [`frontend/src/pages/Dashboard.jsx`](file:///e:/propfirm/frontend/src/pages/Dashboard.jsx)

New `equity_update` socket handler:
- Updates balance/equity KPI cards live
- Updates drawdown progress bar live
- Updates profit target remaining live
- No API re-fetch needed

#### [MODIFY] [`frontend/src/pages/DashboardHome.jsx`](file:///e:/propfirm/frontend/src/pages/DashboardHome.jsx)

Wire equity updates into stat cards and drawdown gauges.

#### [MODIFY] [`frontend/src/components/TradingPanel.jsx`](file:///e:/propfirm/frontend/src/components/TradingPanel.jsx)

Account bar + drawdown gauge update live.

---

### Component 7: Event-Driven Engine Pipeline

#### [MODIFY] [`services/priceBroadcast.js`](file:///e:/propfirm/backend/services/priceBroadcast.js)

```javascript
watchPriceFeed(function (newPrices) {
  const prevPrices = getAllPrices()
  updatePriceCache(newPrices)

  // Which instruments actually changed?
  const changed = getChangedInstruments(prevPrices, newPrices)
  if (changed.length === 0) return

  // For each changed instrument, scan ONLY its trades:
  for (const instrument of changed) {
    const price = newPrices[instrument]
    const trades = getTradesByInstrument(instrument)
    // trades is ~2,500 entries (100K / 40 instruments)
    
    for (const [tradeId, trade] of trades) {
      const closePrice = trade.direction === 1 ? price.bid : price.ask
      
      // SL/TP check (~0.01μs)
      if (trade.stopLoss && isSLTriggered(trade, closePrice)) {
        queueClosure(trade, closePrice, 'Stop Loss')
      }
      if (trade.takeProfit && isTPTriggered(trade, closePrice)) {
        queueClosure(trade, closePrice, 'Take Profit')
      }
      
      // Update floating PnL for this account
      accountEquities.get(trade.accountId).floatingPnl +=
        fastPnL(trade.direction, trade.openPrice, closePrice, trade.lots, trade.contractSize, trade.commission)
    }
  }

  // Check drawdown/profit-target for affected accounts:
  for (const [accountId, entry] of affectedAccounts) {
    const equity = entry.currentBalance + entry.floatingPnl
    if (equity < entry.drawdownFloor) {
      queueAccountFail(accountId, equity)
    } else if (entry.accountType !== 'funded' && equity >= entry.startingBalance + entry.profitTarget) {
      queueAccountPass(accountId, equity)
    }
  }

  // Execute queued closures (bulk DB ops)
  await flushClosureQueue(io)
  
  // Push equity updates to dashboards
  pushEquityUpdates(io, affectedAccounts)
  
  // Broadcast prices to all clients
  io.emit('price_update', newPrices)
})
```

#### [MODIFY] [`services/schedulerService.js`](file:///e:/propfirm/backend/services/schedulerService.js)

Intervals become **safety fallbacks only**:

| Scheduler | Current | New |
|---|---|---|
| checkSLTP | 500ms | 5,000ms (fallback only) |
| checkPendingOrders | 500ms | 5,000ms (fallback only) |
| checkFloatingDrawdown | 1,000ms | 10,000ms (fallback only) |
| Trade index reconciliation | N/A | **30,000ms** (new) |
| Challenge engine | 30,000ms | 30,000ms (unchanged) |

---

### Component 8: Database Indexes

#### [NEW] Added at startup in `server.js`

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_open_sltp
  ON trades (account_id, instrument)
  WHERE status = 'open' AND (stop_loss IS NOT NULL OR take_profit IS NOT NULL);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_pending
  ON trades (account_id, instrument) WHERE status = 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_open
  ON trades (account_id) WHERE status = 'open';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_closed_today
  ON trades (account_id, close_time) WHERE status = 'closed';
```

---

### Component 9: Connection Pool

#### [MODIFY] [`db.js`](file:///e:/propfirm/backend/db.js)

```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 120,                         // was 35
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  allowExitOnIdle: true,
})
```

---

### Component 10: Incremental In-Memory Sync

#### [MODIFY] [`routes/trades.js`](file:///e:/propfirm/backend/routes/trades.js) — trade open/close routes

When a trade is opened via API:
```javascript
tradeIndex.addTrade(newTrade, account)
```

When a trade is closed (manually, SL/TP, drawdown):
```javascript
tradeIndex.removeTrade(tradeId)
tradeIndex.updateAccountBalance(accountId, newBalance)
```

Full reconciliation every 30s:
```javascript
registerTrackedInterval(async () => {
  await tradeIndex.fullReconcileFromDB()
}, 30000)
```

---

## Timing at 100K Trades

### Per Price Tick (~50-200ms from MT5)

```
Step                                    Time
────────────────────────────────────    ──────
fs.watch fires                          ~10ms
Read + parse DWX file                   ~5ms
Update in-memory price cache            ~0.01ms
Detect changed instruments (1-5)        ~0.01ms
Scan trades for changed instruments:
  └─ 2,500 trades × fastPnL            ~0.125ms
  └─ SL/TP check per trade             ~0.05ms
  └─ Account equity aggregation         ~0.5ms
Drawdown/profit-target check            ~0.1ms
Queue + flush closures (if any)         ~15-50ms
Push equity_update to dashboards        ~1ms
Broadcast price_update                  ~1ms
────────────────────────────────────    ──────
TOTAL (no closures)                     ~18ms
TOTAL (with 100 closures)               ~50-70ms
```

### Drawdown Auto-Close Reaction Time

| Scenario | Time from price change |
|---|---|
| Price changes, drawdown breached | **~20-30ms** (pure JS detection) + **~30-50ms** (DB close) = **~50-80ms** |
| Profit target hit | Same **~50-80ms** |
| SL/TP triggered | Same **~50-80ms** |
| Mass breach (500 trades close at once) | **~100-200ms** (bulk UPDATE) |

### Comparison

| Metric | Current | 10K Plan | **100K Plan** |
|---|---|---|---|
| Max concurrent trades | ~500 | ~15,000 | **100,000+** |
| SL/TP reaction | 500-1500ms | 50-200ms | **50-80ms** |
| Drawdown auto-close | 1000-2000ms | 50-200ms | **50-80ms** |
| Profit target auto-close | 1000-2000ms | 50-200ms | **50-80ms** |
| Dashboard equity latency | Manual refresh | Every tick | **Every tick** |
| DB queries/tick (idle) | ~12/s | ~2/s | **~0.5/s** |
| Memory usage | ~50MB | ~70MB | **~100MB** (+20MB trade index) |
| Event loop block per tick | ~50-200ms | ~5-20ms | **~3-8ms** |

---

## Files Modified Summary

| File | Change |
|---|---|
| **[NEW]** `backend/utils/priceCache.js` | In-memory price singleton |
| **[NEW]** `backend/utils/tradeIndex.js` | Instrument-indexed trade map |
| **[NEW]** `backend/utils/fastPnL.js` | Native float PnL calculator |
| `backend/routes/trades.js` | Batched closures, index sync, remove per-tick infra check |
| `backend/services/priceBroadcast.js` | Event-driven engine pipeline + equity push |
| `backend/services/schedulerService.js` | Intervals → safety fallbacks |
| `backend/services/drawdownService.js` | Pure-function floor calc + batch peak update |
| `backend/db.js` | Pool size 35 → 120 |
| `backend/server.js` | New indexes + trade index init |
| `frontend/src/pages/Dashboard.jsx` | `equity_update` socket handler |
| `frontend/src/pages/DashboardHome.jsx` | Live KPI cards + drawdown gauge |
| `frontend/src/components/TradingPanel.jsx` | Live account bar + drawdown |

---

## Open Questions

> [!IMPORTANT]
> **PostgreSQL max_connections:** Your DB needs to support 120 connections. What's your current PostgreSQL `max_connections` setting? (Default is usually 100 — we'd need to bump it to 150+.)

> [!NOTE]
> Worker threads are **designed but deferred**. The instrument-indexed approach makes 100K trades scannable in ~3-8ms on the main thread. Workers would be added if real-world profiling shows >20ms per tick.
