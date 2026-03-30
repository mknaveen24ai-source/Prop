# 🔧 Price Feed Latency Fix

## Problem
Users were seeing the error:
> "Price feed is currently delayed. Close rejected due to volatility protection/latency."

This occurred when the MT5 price feed was more than 3 seconds old, causing trade orders and closes to be rejected.

## Root Causes
1. **Too strict timeout** - 3-second threshold was too aggressive for MT5 file-based price feeds
2. **Slow fallback polling** - Fallback interval was 2 seconds, creating gaps in price updates
3. **No visibility** - Users couldn't see if the price feed was healthy or delayed
4. **No stale data detection** - System didn't log when prices were getting stale

## Fixes Applied

### Backend (`backend/`)

#### 1. `routes/trades.js` - Increased Price Age Tolerance
**Before:** 3000ms (3 seconds)
**After:** 10000ms (10 seconds)

```javascript
// Market orders
if (priceAgeMs > 10000) {
  logger.warn('Price feed too old:', { instrument, ageMs })
  return res.status(400).json({ error: 'Price feed is currently delayed...' })
}

// Close trades
if (priceAgeMs > 10000) {
  logger.warn('Price feed too old on close:', { instrument, ageMs })
  return res.status(400).json({ error: 'Price feed is currently delayed...' })
}
```

#### 2. `server.js` - Faster Fallback Polling
**Before:** 2000ms with conditional skip
**After:** 1000ms continuous polling

```javascript
// Fallback polling - runs every 1 second to ensure prices stay fresh
setInterval(async function() {
  await fetchAndStorePrices()
  const prices = await getCurrentPrices()
  if (Object.keys(prices).length > 0) {
    io.emit('price_update', prices)
  }
}, 1000)
```

Also updated `WATCHER_TIMEOUT_MS` from 3000ms to 10000ms to match trade validation.

#### 3. `priceFeed.js` - Stale Data Detection
Added age tracking and stale detection to `getCurrentPrices()`:

```javascript
const ageMs = now - new Date(row.updated_at).getTime()
prices[row.instrument] = {
  bid: parseFloat(row.bid),
  ask: parseFloat(row.ask),
  updated_at: row.updated_at,
  age_ms: ageMs,
  stale: ageMs > 5000 // Mark as stale if older than 5 seconds
}
```

#### 4. `server.js` - New Public Price Status Endpoint
Added `/api/price-status` for users to check feed health:

```javascript
app.get('/api/price-status', async function(req, res) {
  const prices = await getCurrentPrices()
  const status = {
    healthy: true,
    instruments: {},
    message: 'Price feed operational'
  }
  
  for (const [instrument, data] of Object.entries(prices)) {
    const ageMs = data.age_ms || (now - new Date(data.updated_at).getTime())
    status.instruments[instrument] = {
      age_seconds: Math.round(ageMs / 1000),
      healthy: ageMs < 5000
    }
    if (ageMs >= 5000) status.healthy = false
  }
  
  res.json(status)
})
```

### Frontend (`frontend/`)

#### 1. `components/TradingPanel.js` - Price Feed Status Indicator
Added real-time status monitoring and visual indicator:

```javascript
const [priceStatus, setPriceStatus] = useState({ healthy: true, instruments: {} })

useEffect(() => {
  async function fetchPriceStatus() {
    const res = await axios.get(`${API_URL}/api/price-status`)
    setPriceStatus(res.data)
  }
  fetchPriceStatus()
  const interval = setInterval(fetchPriceStatus, 5000)
  return () => clearInterval(interval)
}, [])
```

**Visual Indicator:**
- 🟢 **Live** (green) - Price feed is healthy (< 5 seconds old)
- 🔴 **Delayed** (red, pulsing) - Price feed is stale (≥ 5 seconds old)

#### 2. `App.css` - Pulse Animation
Added CSS animation for delayed state:

```css
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

## Configuration Recommendations

### MT5/DWX Setup
Ensure your MT5 terminal with DWX bridge is:
1. **Running continuously** - MT5 must be open and connected
2. **Properly configured** - DWX_PATH in `.env` points to correct folder
3. **Receiving ticks** - Check MT5 has active market data subscription

### Environment Variables
```env
# Path to DWX bridge folder
DWX_PATH=C:/Users/YOU/AppData/Roaming/MetaQuotes/.../DWX

# Price feed settings
PRICE_HISTORY_RETAIN_DAYS=7
```

## Testing

### Check Price Feed Status
```bash
# Via API
curl http://localhost:5000/api/price-status

# Expected response (healthy):
{
  "healthy": true,
  "instruments": {
    "EURUSD": { "age_seconds": 1, "healthy": true },
    "GBPUSD": { "age_seconds": 1, "healthy": true },
    "XAUUSD": { "age_seconds": 2, "healthy": true },
    "XAGUSD": { "age_seconds": 2, "healthy": true }
  },
  "message": "Price feed operational"
}
```

### Via Admin Panel
Navigate to: **Admin Panel → 📡 Price Feed**
- Shows individual instrument status
- Displays seconds since last update
- Shows operational/delayed status

## Troubleshooting

### If prices are still delayed:

1. **Check MT5 is running**
   ```bash
   # Verify DWX file exists
   dir "C:\Path\To\DWX\DWX_Market_Data.txt"
   ```

2. **Check backend logs**
   ```
   [Price feed] MT5 prices updating normally
   [Price feed] Price feed has stale data: { staleCount: 2, total: 4 }
   ```

3. **Restart price feed subscription**
   - Restart the backend server
   - Check `subscribeSymbols()` ran successfully

4. **Verify MT5 symbol subscription**
   - Open MT5 terminal
   - Check "Market Watch" has EURUSD, GBPUSD, XAUUSD, XAGUSD
   - Verify ticks are updating in MT5

5. **Check file permissions**
   - Ensure Node.js can read DWX folder
   - MT5 and Node.js need concurrent file access

## Performance Impact

| Metric | Before | After |
|--------|--------|-------|
| Price tolerance | 3s | 10s |
| Fallback interval | 2s | 1s |
| Stale detection | ❌ | ✅ (>5s) |
| User visibility | ❌ | ✅ (Live/Delayed) |
| API health check | Admin only | Public |

## Files Modified

### Backend
- ✅ `backend/routes/trades.js` - Increased price age tolerance
- ✅ `backend/server.js` - Faster polling + status endpoint
- ✅ `backend/priceFeed.js` - Stale data detection

### Frontend
- ✅ `frontend/components/TradingPanel.js` - Status indicator
- ✅ `frontend/src/App.css` - Pulse animation

## Future Enhancements (Optional)
- WebSocket push for price status changes
- Price feed quality score (0-100%)
- Historical uptime tracking
- Alerts when feed becomes stale
- Auto-reconnect logic for DWX bridge
