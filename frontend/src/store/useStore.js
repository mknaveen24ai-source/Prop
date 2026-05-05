import { create } from 'zustand';

const useStore = create((set, get) => ({

  // ── ACTIVE ACCOUNT ──────────────────────────────
  activeAccount: null,
  allAccounts: [],

  setActiveAccount: (account) => set({ activeAccount: account }),
  setAllAccounts: (accounts) => set({
    allAccounts: accounts,
    activeAccount: accounts[0] || null
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

  addPosition: (position) => set(state => ({
    openPositions: [...state.openPositions, position]
  })),

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

}));

export default useStore;
