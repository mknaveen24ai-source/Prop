import { create } from 'zustand';

const useStore = create((set, get) => ({

  // ── ACTIVE ACCOUNT ──────────────────────────────
  activeAccount: null,
  allAccounts: [],

  setActiveAccount: (account) => set({ activeAccount: account }),

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
  }),

  switchAccount: (accountId) => {
    const account = get().allAccounts.find(a => a.id === accountId);
    if (account) set({ activeAccount: account });
  },

  // ── LIVE PRICES ──────────────────────────────────
  prices: {},
  // prices shape: { EURUSD: { bid: 1.08420, ask: 1.08435, spread: 1.5 }, ... }

  updatePrice: (instrument, priceData) => set(state => ({
    prices: { ...state.prices, [instrument]: priceData }
  })),

  updatePrices: (pricesObj) => set({ prices: pricesObj }),

  // ── OPEN POSITIONS ────────────────────────────────
  openPositions: [],
  totalFloatingPnL: 0,

  setOpenPositions: (positions) => {
    const total = positions.reduce((sum, p) => sum + (p.floating_pnl || 0), 0);
    set({ openPositions: positions, totalFloatingPnL: total });
  },

  updatePositionPnL: (tradeId, floatingPnL) => set(state => {
    const updated = state.openPositions.map(p =>
      p.id === tradeId ? { ...p, floating_pnl: floatingPnL } : p
    );
    const total = updated.reduce((sum, p) => sum + (p.floating_pnl || 0), 0);
    return { openPositions: updated, totalFloatingPnL: total };
  }),

  // BUG-08 FIX: addPosition now recalculates totalFloatingPnL so the dashboard
  // shows the correct total immediately when a new trade is opened.
  // Previously totalFloatingPnL was only updated by updatePositionPnL (price
  // ticks) and removePosition, so the total was wrong until the next price tick.
  addPosition: (position) => set(state => {
    const updated = [...state.openPositions, position];
    const total = updated.reduce((sum, p) => sum + (p.floating_pnl || 0), 0);
    return { openPositions: updated, totalFloatingPnL: total };
  }),

  removePosition: (tradeId) => set(state => {
    const updated = state.openPositions.filter(p => p.id !== tradeId);
    const total = updated.reduce((sum, p) => sum + (p.floating_pnl || 0), 0);
    return { openPositions: updated, totalFloatingPnL: total };
  }),

  // ── NOTIFICATIONS ─────────────────────────────────
  unreadCount: 0,
  incrementUnread: () => set(state => ({ unreadCount: state.unreadCount + 1 })),
  clearUnread: () => set({ unreadCount: 0 }),

  // ── MARKET STATUS ─────────────────────────────────
  marketOpen: false,
  setMarketOpen: (status) => set({ marketOpen: status }),

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
  })),

  clearLiveEquity: () => set({ liveEquity: {} }),

}));

export default useStore;
