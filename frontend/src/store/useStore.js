import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// devtools gives a named, time-travellable log of every state change, which is
// what makes a "why did equity flicker" bug tractable. Disabled outside dev so
// the production bundle never talks to the extension.
//
// Each set() below passes a third argument naming the action — without it the
// devtools timeline is an undifferentiated list of "anonymous" entries, which
// is most of the value gone.
//
// Note on immer: it was considered here and deliberately left out. These
// reducers are already small, flat and immutable; adding immer would mean a
// dependency plus rewriting working money-adjacent state handling to gain
// nothing at this size. Worth revisiting if the store grows nested state.
const useStore = create(devtools((set, get) => ({

  // ── ACTIVE ACCOUNT ──────────────────────────────
  activeAccount: null,
  allAccounts: [],

  setActiveAccount: (account) => set({ activeAccount: account }, false, 'setActiveAccount'),

  setAllAccounts: (accounts) => set(state => {
    // BUG-12 FIX: Preserve the user's manually-selected account when accounts
    // are refreshed (e.g. after a trade closes or on socket reconnect).
    // Previously this always reset to accounts[0], losing user's selection.
    const currentId = state.activeAccount?.id
    const stillExists = accounts.find(a => a.id === currentId)
    return {
      allAccounts: accounts,
      // BUG-21 FIX: Guard against empty accounts array — null is a safe default
      // and prevents null-access crashes in components that read activeAccount.
      activeAccount: stillExists || accounts[0] || null
    }
  }, false, 'setAllAccounts'),

  switchAccount: (accountId) => {
    const account = get().allAccounts.find(a => a.id === accountId);
    if (account) set({ activeAccount: account }, false, 'switchAccount');
  },

  // ── LIVE PRICES ──────────────────────────────────
  prices: {},
  // prices shape: { EURUSD: { bid: 1.08420, ask: 1.08435, spread: 1.5 }, ... }

  updatePrice: (instrument, priceData) => set(state => ({
    prices: { ...state.prices, [instrument]: priceData }
  }), false, 'updatePrice'),

  updatePrices: (pricesObj) => set({ prices: pricesObj }, false, 'updatePrices'),

  // ── OPEN POSITIONS ────────────────────────────────
  openPositions: [],
  totalFloatingPnL: 0,

  setOpenPositions: (positions) => {
    const total = positions.reduce((sum, p) => sum + (p.floating_pnl || 0), 0);
    set({ openPositions: positions, totalFloatingPnL: total }, false, 'setOpenPositions');
  },

  updatePositionPnL: (tradeId, floatingPnL) => set(state => {
    const updated = state.openPositions.map(p =>
      p.id === tradeId ? { ...p, floating_pnl: floatingPnL } : p
    );
    const total = updated.reduce((sum, p) => sum + (p.floating_pnl || 0), 0);
    return { openPositions: updated, totalFloatingPnL: total };
  }, false, 'updatePositionPnL'),

  // BUG-08 FIX: addPosition now recalculates totalFloatingPnL so the dashboard
  // shows the correct total immediately when a new trade is opened.
  // Previously totalFloatingPnL was only updated by updatePositionPnL (price
  // ticks) and removePosition, so the total was wrong until the next price tick.
  addPosition: (position) => set(state => {
    const updated = [...state.openPositions, position];
    const total = updated.reduce((sum, p) => sum + (p.floating_pnl || 0), 0);
    return { openPositions: updated, totalFloatingPnL: total };
  }, false, 'addPosition'),

  removePosition: (tradeId) => set(state => {
    const updated = state.openPositions.filter(p => p.id !== tradeId);
    const total = updated.reduce((sum, p) => sum + (p.floating_pnl || 0), 0);
    return { openPositions: updated, totalFloatingPnL: total };
  }, false, 'removePosition'),

  // ── NOTIFICATIONS ─────────────────────────────────
  unreadCount: 0,
  incrementUnread: () => set(state => ({ unreadCount: state.unreadCount + 1 }), false, 'incrementUnread'),
  clearUnread: () => set({ unreadCount: 0 }, false, 'clearUnread'),

  // ── MARKET STATUS ─────────────────────────────────
  marketOpen: false,
  setMarketOpen: (status) => set({ marketOpen: status }, false, 'setMarketOpen'),

  // ── LIVE EQUITY ───────────────────────────────────────
  // Pushed by the backend on every engine tick (ENGINE_MODE=event) via the
  // `equity_update` socket event. Lives in the store rather than in Dashboard
  // state because DashboardHome and TradingPanel need it too, and they have no
  // socket of their own — this avoids threading it down through props.
  //
  // Under ENGINE_MODE=interval no equity_update events arrive and this stays
  // empty, so every consumer must fall back to its fetched account values.
  //
  // Shape: { [accountId]: { equity, floating_pnl, current_balance,
  //          drawdown_floor, drawdown_used_pct, daily_drawdown_used_pct,
  //          daily_drawdown_limit_pct, profit_remaining, received_at } }
  liveEquity: {},

  updateLiveEquity: (accountId, data) => set(state => ({
    liveEquity: {
      ...state.liveEquity,
      [accountId]: { ...data, received_at: Date.now() }
    }
  }), false, 'updateLiveEquity'),

  clearLiveEquity: () => set({ liveEquity: {} }, false, 'clearLiveEquity'),

}), {
  name: 'PropFirmStore',
  enabled: import.meta.env.DEV
}));

export default useStore;
