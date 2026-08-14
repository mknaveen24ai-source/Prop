// Shared crypto payout method config — used by both DashboardPayoutsPage.jsx
// (trader payouts) and DashboardAffiliatePage.jsx (affiliate commission
// payouts), which previously each hand-rolled their own near-identical copy.
export const CRYPTO_CURRENCIES = [
  { id: 'usdt', label: 'USDT', meta: 'Tether — select network below', tone: 'var(--gain)' },
  { id: 'btc', label: 'Bitcoin', meta: 'BTC', tone: 'var(--warn)' },
  { id: 'ltc', label: 'Litecoin', meta: 'LTC', tone: 'var(--accent)' },
]

export const USDT_NETWORKS = [
  { id: 'trc20', label: 'TRC20', meta: 'Tron — lowest fees', tone: 'var(--gain)' },
  { id: 'bep20', label: 'BEP20', meta: 'BNB Smart Chain', tone: 'var(--warn)' },
  { id: 'erc20', label: 'ERC20', meta: 'Ethereum', tone: 'var(--accent)' },
  { id: 'polygon', label: 'Polygon', meta: 'Polygon PoS', tone: 'var(--muted)' },
]
