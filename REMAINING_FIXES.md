# Remaining Bug Fixes - Manual Application Required

## HIGH Severity Fixes Remaining

### HIGH #8: Chat Component Socket Connection Leak
**File:** `frontend/src/pages/Chat.js`
**Fix:** Replace module-scoped `let socket = null` with useRef pattern

```javascript
// At top of component:
const socketRef = useRef(null)

// In useEffect where socket is created:
socketRef.current = io(process.env.REACT_APP_API_URL || 'http://localhost:5000', {
  withCredentials: true
})

// In cleanup:
return () => {
  if (socketRef.current) {
    socketRef.current.disconnect()
    socketRef.current = null
  }
}
```

### HIGH #9: Payout Flagging Logic Bypass
**File:** `backend/routes/payouts.js`
**Fix:** Add cumulative payout tracking - requires schema change:
```sql
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS total_payouts NUMERIC DEFAULT 0;
```
Then in payout validation:
```javascript
const totalPayouts = parseFloat(acc.total_payouts || 0) + amountNum
if (totalPayouts > accountSize * 0.80 && accountAge < 30) {
  flags.push('cumulative_payout_exceeds_threshold')
}
```

### HIGH #10: News Force-Close Error Recovery
**File:** `backend/server.js` ~line 700
**Fix:** Add try-catch with state reset:
```javascript
async function checkNewsForceClose() {
  try {
    const activeNews = newsService.getActiveNewsEvent(3)
    // ... existing logic
  } catch (error) {
    logger.error('News force-close check error:', { error: error.message })
    lastClosedNewsId = '' // Reset to prevent duplicate closures
  }
}
```

### HIGH #11: Frontend API Interceptor 401 Redirect
**File:** `frontend/src/services/api.js`
**Fix:** Only redirect for user-initiated requests:
```javascript
if (error.response?.status === 401 || error.response?.status === 403) {
  // Don't redirect for background polling, uploads, etc.
  const isUserInitiated = error.config?.headers?.['X-User-Initiated'] === 'true'
  if (isUserInitiated && !window.location.pathname.includes('/login')) {
    localStorage.setItem('redirectAfterLogin', window.location.pathname)
    window.location.href = '/login'
  }
  return Promise.reject(error)
}
```

### HIGH #12: Reduce checkFloatingDrawdown Polling
**File:** `backend/server.js` line ~677
**Fix:** Change from 500ms to 1000ms:
```javascript
setInterval(function() { checkFloatingDrawdown(io) }, 1000) // Was 500
```

## MEDIUM Severity Fixes (Summary)

### #13: Market Status Logic Mismatch
**File:** `frontend/src/components/OrderPanel.js`
**Fix:** Align weekend logic with backend - only apply rollover Mon-Fri

### #14: Notification ID Collisions  
**File:** `frontend/src/pages/Dashboard.js`
**Fix:** Use `crypto.randomUUID()` instead of `Date.now()`

### #15: CSV Filename Sanitization
**File:** `frontend/src/components/TradingPanel.js`
**Fix:** Sanitize accountType and accountSize before using in filename

### #16-24: Various Medium Fixes
See BUG_ANALYSIS_REPORT.md for detailed descriptions. These include:
- MultiChartGrid cleanup race condition
- Analytics stale closure
- Debounce utility return value
- Admin axios error interceptor
- News service validation
- Trailing stop loss transactions
- Notification bell behavior
- Chat typing timeout
- sanitizeString improvements

## LOW Severity Fixes (Summary)

### #25-32: Various LOW Fixes
- VALID_ACCOUNT_SIZES sync with backend
- CONTRACT_SIZES single source of truth
- Sidebar version from package.json
- Remove duplicate security headers
- Fix dead code in validation
- HTTP logging exclusions
- React import consistency
- MultiChartGrid symbol optimization

## Priority Order for Remaining Fixes

1. **HIGH #8** - Socket connection leak (memory issue)
2. **HIGH #10** - News error recovery (data integrity)
3. **HIGH #11** - API redirect behavior (UX issue)
4. **HIGH #12** - Polling frequency (performance)
5. **HIGH #9** - Payout bypass (business logic)
6. **MEDIUM #13-24** - Various improvements
7. **LOW #25-32** - Code quality improvements
