# Trader Terminal QA Checklist

This checklist is for the trader terminal only. It focuses on the recent fixes in:

- [E:\propfirm\frontend\src\components\MultiChartGrid.js](E:/propfirm/frontend/src/components/MultiChartGrid.js)
- [E:\propfirm\frontend\src\components\OrderPanel.js](E:/propfirm/frontend/src/components/OrderPanel.js)
- [E:\propfirm\frontend\src\components\TradingPanel.js](E:/propfirm/frontend/src/components/TradingPanel.js)
- [E:\propfirm\frontend\src\pages\Dashboard.js](E:/propfirm/frontend/src/pages/Dashboard.js)

## Test Matrix

Run this on:

- Desktop Chrome or Edge
- Tablet width or browser device emulation
- Mobile width or browser device emulation

Preferred device widths:

- Desktop: `1440px+`
- Laptop: `1280px`
- Tablet: `768px - 1024px`
- Mobile: `375px - 430px`

## Pre-Flight

Before testing:

1. Log in as a trader with an approved KYC account.
2. Open an account that has live prices and permission to trade.
3. Make sure at least one instrument has active prices.
4. If possible, use a test account where opening and modifying trades is safe.

Expected:

- Trader dashboard loads without console errors.
- `Trade` page opens normally.
- No old `Shots` UI is visible anywhere in the terminal.
- No `Risk per trade` box is visible in the order panel.

## Theme Checks

### Dark Mode

Steps:

1. Open the `Trade` page in dark mode.
2. Review top bar, chart shell, chart panes, stats cards, and order panel.

Expected:

- Trader terminal looks intentionally dark.
- Chart text and grid are readable.
- Order inputs, toggles, and cards remain high contrast.

### Light Mode

Steps:

1. Switch to light mode.
2. Review the same areas again.

Expected:

- The page is truly light, not a white page with dark cards left behind.
- Top bar, cards, order panel, chart shell, and pane shells all use bright surfaces.
- Chart text, axes, and grid remain readable.
- No major dark overlay remains on key trader surfaces.

## Chart Layout Checks

### Focus Layout

Steps:

1. Set layout to `Focus`.
2. Change timeframe a few times.
3. Confirm price updates continue without flicker.

Expected:

- Single chart fills the workspace correctly.
- Timeframe buttons work.
- Chart does not remount or visibly flicker on normal live updates.

### Split Layout

Steps:

1. Switch to `Split`.
2. Change the symbol in each pane.
3. Change pane 1 symbol and confirm the main instrument changes with it.

Expected:

- Both panes render cleanly.
- Each pane has its own symbol selector.
- Pane 1 remains synced with the main trading symbol.
- Changing pane 2 does not incorrectly change pane 1.

### Quad Layout

Steps:

1. Switch to `Quad`.
2. Change symbols across all four panes.
3. Resize browser to tablet and mobile widths.

Expected:

- All panes render without overlap.
- Symbols remain independently selectable.
- Layout collapses gracefully on smaller widths.
- No pane controls are clipped off-screen.

## Active Trade Overlay Checks

Steps:

1. Open a live trade on the currently selected symbol.
2. Confirm the chart shows:
   - `ENTRY`
   - `SL` if stop loss exists
   - `TP` if take profit exists
3. Open a second trade on the same symbol if supported.

Expected:

- Entry line appears at `open_price`.
- Stop-loss and take-profit lines appear at the correct prices.
- Labels show compact tags and prices.
- Multiple trades on the same symbol can coexist without crashing the overlay.

## SL/TP Drag Checks

### Desktop Mouse

Steps:

1. Drag the `SL` line up/down.
2. Drag the `TP` line up/down.
3. Try dragging the `ENTRY` line.

Expected:

- `SL` drag updates visually while dragging.
- `TP` drag updates visually while dragging.
- On release, the new value is submitted.
- `ENTRY` is not draggable.

### Tablet / Mobile Touch

Steps:

1. On touch device or emulation, drag `SL`.
2. Drag `TP`.
3. Try dragging `ENTRY`.

Expected:

- Drag works with touch, not just mouse.
- Drag follows the same pointer cleanly.
- Release commits the new value once.
- `ENTRY` still does not move.

## Order Panel Checks

### Market Orders

Steps:

1. In market mode, set lot size, optional SL, optional TP.
2. Use the `Preview BUY / Preview SELL` toggle in the `R:R` card.
3. Confirm the preview changes between bid/ask based on side.
4. Place a buy order.
5. Place a sell order.

Expected:

- No `Risk per trade` controls exist.
- `R:R` preview works before order placement.
- Preview is usable on mobile, not hover-dependent.
- Buy and sell orders submit normally.

### Pending Orders

Steps:

1. Switch to pending mode.
2. Test `Buy Limit`, `Sell Limit`, `Buy Stop`, and `Sell Stop`.
3. Confirm order explanation copy updates correctly.
4. Test optional OCO sibling order.

Expected:

- Pending order types render correctly.
- Direction logic matches the selected pending type.
- OCO controls appear only when enabled.

## Trade Management Checks

### Full Close

Steps:

1. Click `Close` on an open trade.
2. Rapidly click `Close` more than once on another trade.

Expected:

- Close request runs once per trade.
- Button changes to `Closing...` while in flight.
- Duplicate close submission is blocked.

### Partial Close

Steps:

1. Open the partial-close form.
2. Try entering:
   - a valid partial amount
   - zero
   - more than current lots
   - the full lot size
3. Use the quick percentage buttons.
4. Rapidly click partial-close confirm.

Expected:

- Valid partial close works once.
- Invalid amounts are rejected.
- Full-lot partial close is blocked and the dedicated `Close` action remains the full-exit path.
- Duplicate partial-close submission is blocked while the request is running.

### Modify Trade

Steps:

1. Open the modify form.
2. Update `SL`, `TP`, trailing step, trailing activation, and breakeven trigger.
3. Use `Move To BE`.

Expected:

- Modify form saves correctly.
- Chart overlay reflects new values after refresh/update.
- No stale screenshot or risk-sizing behavior appears.

## History / Journal Checks

Steps:

1. Open and close trades.
2. Review trade history and open-trade table.
3. Open the journal editor for a trade.

Expected:

- No screenshot preview tiles or `Shots` badges appear.
- Journal editing still works.
- Repeat-last-trade still populates the expected fields.

## Responsive Acceptance Checks

### Mobile

Expected:

- No major horizontal overflow.
- Order panel remains reachable and usable.
- Chart controls stay tappable.
- `Preview BUY / Preview SELL` is usable without hover.

### Tablet

Expected:

- Split and quad layouts remain operable.
- Chart drag works with touch.
- Table actions remain reachable without overlapping.

### Desktop

Expected:

- Focus, split, and quad remain stable.
- No flicker on normal live updates.
- No clipped controls.

## Regression Sign-Off

Mark pass only if all are true:

- No `Risk per trade` UI remains in trader flow.
- No `Shots` UI remains in trader flow.
- `ENTRY`, `SL`, and `TP` chart lines render correctly.
- Only `SL` and `TP` are draggable.
- Drag works on mouse and touch.
- Full close and partial close are both duplicate-safe.
- Light mode is genuinely light.
- `npm run build` passes.

## Final Result

Sign-off:

- `PASS` if every section above behaves as expected.
- `FAIL` if any of these break:
  - drag interaction
  - order placement
  - close / partial close safety
  - light mode readability
  - split / quad responsiveness
