import React, { useEffect, useMemo, useState } from 'react'
import { tradesAPI } from '../services/api'
import Card from '../components/ui/Card'
import Sparkline from '../components/ui/Sparkline'
import EquityCurveChart from '../components/EquityCurveChart'
import ListToolbar from '../components/ui/ListToolbar'
import FilterChips from '../components/ui/FilterChips'
import Drawer from '../components/ui/Drawer'
import Table from '../components/ui/Table'
import Pagination from '../components/Pagination'
import { renderIcon } from '../utils/iconMap'
import { formatCurrency } from '../utils/finance'
import { getStatusColor } from '../utils/constants'
import { formatPrice } from '../utils/instruments'
import { exportRowsToCSV } from '../utils/exportCsv'
import { API_BASE_URL as API_URL } from '../config/apiBase'

const PAGE_SIZE = 15

function formatSigned(value) {
  return formatCurrency(value, { signed: true })
}

const priceDecimals = (instrument) => (instrument?.includes('JPY') ? 3 : 5)

// `primary` names the card's title on mobile; `hideOnMobile` drops the columns
// that are reference detail rather than the reason you scan the list. The full
// record is still one tap away in the drawer.
const TRADE_COLUMNS = [
  { key: 'instrument', header: 'Instrument', primary: true },
  {
    key: 'direction',
    header: 'Side',
    render: (t) => (
      <span className="lx-badge" style={{ color: t.direction === 'buy' ? 'var(--gain)' : 'var(--loss)' }}>
        {t.direction === 'buy' ? 'BUY' : 'SELL'}
      </span>
    ),
  },
  { key: 'lot_size', header: 'Lots', num: true, render: (t) => parseFloat(t.lot_size).toFixed(2) },
  {
    key: 'open_price', header: 'Entry', num: true, hideOnMobile: true,
    render: (t) => parseFloat(t.open_price).toFixed(priceDecimals(t.instrument)),
  },
  {
    key: 'close_price', header: 'Exit', num: true, hideOnMobile: true,
    render: (t) => (t.close_price != null ? parseFloat(t.close_price).toFixed(priceDecimals(t.instrument)) : '—'),
  },
  {
    key: 'r_multiple', header: 'R', num: true,
    render: (t) => (
      <span style={{ color: 'var(--muted)' }}>{t.r_multiple != null ? `${t.r_multiple.toFixed(2)}R` : '—'}</span>
    ),
  },
  {
    key: 'close_time', header: 'Closed', num: true,
    render: (t) => (t.close_time ? new Date(t.close_time).toLocaleDateString() : '—'),
  },
  {
    key: 'demo_pnl', header: 'P&L', num: true,
    render: (t) => {
      const pnl = parseFloat(t.demo_pnl || 0)
      return <span style={{ color: pnl >= 0 ? 'var(--gain)' : 'var(--loss)' }}>{formatSigned(pnl)}</span>
    },
  },
]

// Relocated from TradingPanel.jsx — this screen is where "export the closed
// trade log" actually belongs now (Trade screen no longer hosts one).
const TRADE_EXPORT_COLUMNS = [
  { header: 'ID', value: (t) => t.id },
  { header: 'Instrument', value: (t) => t.instrument },
  { header: 'Direction', value: (t) => t.direction },
  { header: 'Lots', value: (t) => parseFloat(t.lot_size).toFixed(2) },
  { header: 'Open Price', value: (t) => (t.open_price ? formatPrice(t.open_price, t.instrument) : '') },
  { header: 'Close Price', value: (t) => (t.close_price ? formatPrice(t.close_price, t.instrument) : '') },
  { header: 'Open Time', value: (t) => (t.open_time ? new Date(t.open_time).toISOString() : '') },
  { header: 'Close Time', value: (t) => (t.close_time ? new Date(t.close_time).toISOString() : '') },
  { header: 'R-Multiple', value: (t) => (t.r_multiple != null ? t.r_multiple.toFixed(2) : '') },
  { header: 'P&L', value: (t) => (t.demo_pnl ? parseFloat(t.demo_pnl).toFixed(2) : '0.00') },
  { header: 'Close Reason', value: (t) => t.close_reason || 'Manual' },
]

function exportTradesToCSV(trades, accountType, accountSize) {
  const safeAccountType = String(accountType || 'account').replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeAccountSize = String(accountSize || '').replace(/[^a-zA-Z0-9_.]/g, '_')
  exportRowsToCSV(trades, TRADE_EXPORT_COLUMNS, `trade_history_${safeAccountType}_${safeAccountSize}_${new Date().toISOString().slice(0, 10)}.csv`)
}

const OUTCOME_CHIPS = [
  { id: '', label: 'All' },
  { id: 'win', label: 'Wins' },
  { id: 'loss', label: 'Losses' },
]

/**
 * Trade History — the "closed trade log, list pattern" screen (Modern
 * Gazette handoff spec). The prototype never actually designed this screen
 * (its own STUBS/"Not in this cut" fallback covers it) — built from the
 * shared list/table pattern contract instead: KPI strip, search, filter
 * chips, table, row-click drawer, pagination.
 */
export default function DashboardTradeHistoryPage({ selectedAccount, accountHistory = [] }) {
  const [trades, setTrades] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [instrumentFilter, setInstrumentFilter] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState('')
  const [page, setPage] = useState(1)
  const [drawerTrade, setDrawerTrade] = useState(null)

  useEffect(() => {
    if (!selectedAccount?.id) { setTrades([]); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    tradesAPI.getTradeHistory(selectedAccount.id)
      .then((res) => { if (!cancelled) setTrades(Array.isArray(res.data) ? res.data : []) })
      .catch(() => { if (!cancelled) setTrades([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectedAccount?.id])

  useEffect(() => { setPage(1) }, [search, instrumentFilter, outcomeFilter])

  const closedTrades = useMemo(() => trades.filter((t) => t.status === 'closed'), [trades])

  const instrumentChips = useMemo(() => {
    const unique = [...new Set(closedTrades.map((t) => t.instrument))].sort()
    return [{ id: '', label: 'All Instruments' }, ...unique.map((sym) => ({ id: sym, label: sym }))]
  }, [closedTrades])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return closedTrades.filter((t) => {
      if (instrumentFilter && t.instrument !== instrumentFilter) return false
      const pnl = parseFloat(t.demo_pnl || 0)
      if (outcomeFilter === 'win' && pnl <= 0) return false
      if (outcomeFilter === 'loss' && pnl >= 0) return false
      if (q && !`${t.instrument} ${t.direction} ${t.close_reason || ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [closedTrades, search, instrumentFilter, outcomeFilter])

  const kpis = useMemo(() => {
    const total = closedTrades.length
    const pnls = closedTrades.map((t) => parseFloat(t.demo_pnl || 0))
    const winningPnls = pnls.filter((p) => p > 0)
    const losingPnls = pnls.filter((p) => p < 0)
    const wins = winningPnls.length
    const winRate = total > 0 ? (wins / total) * 100 : 0
    const totalPnl = pnls.reduce((sum, p) => sum + p, 0)
    const rValues = closedTrades.map((t) => t.r_multiple).filter((r) => r != null)
    const avgR = rValues.length ? rValues.reduce((a, b) => a + b, 0) / rValues.length : null
    const grossProfit = winningPnls.reduce((sum, p) => sum + p, 0)
    const grossLoss = Math.abs(losingPnls.reduce((sum, p) => sum + p, 0))
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : null)
    const bestTrade = pnls.length ? Math.max(...pnls) : null
    const worstTrade = pnls.length ? Math.min(...pnls) : null
    const avgWin = winningPnls.length ? grossProfit / winningPnls.length : null
    const avgLoss = losingPnls.length ? losingPnls.reduce((sum, p) => sum + p, 0) / losingPnls.length : null
    // Cumulative P&L walk in close order, oldest first — powers both the
    // decorative KPI sparklines and the full equity curve chart below.
    let running = 0
    const cumulative = [...closedTrades].reverse().map((t) => {
      running += parseFloat(t.demo_pnl || 0)
      return {
        value: running,
        label: t.close_time ? new Date(t.close_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
      }
    })
    const spark = cumulative.map((p) => ({ value: p.value }))
    return { total, winRate, totalPnl, avgR, spark, profitFactor, bestTrade, worstTrade, avgWin, avgLoss, cumulative }
  }, [closedTrades])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div>
      {!selectedAccount ? (
        <Card style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)' }}>Select an account to see its closed trades.</p>
        </Card>
      ) : loading ? (
        <Card style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)' }}>Loading trade history…</p>
        </Card>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px,1fr))', gap: '14px', marginBottom: '20px' }}>
            <Card stat tone="var(--accent)">
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Win Rate</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', marginTop: '8px', color: 'var(--accent)' }}>{kpis.winRate.toFixed(1)}%</div>
              <Sparkline data={kpis.spark} tone="var(--accent)" width={74} height={26} />
            </Card>
            <Card stat tone="var(--muted)">
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Total Trades</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', marginTop: '8px' }}>{kpis.total}</div>
            </Card>
            <Card stat tone="var(--accent)">
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Avg R-Multiple</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', marginTop: '8px', color: 'var(--accent)' }}>{kpis.avgR != null ? `${kpis.avgR.toFixed(2)}R` : '—'}</div>
            </Card>
            <Card stat tone={kpis.totalPnl >= 0 ? 'var(--gain)' : 'var(--loss)'}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Total P&amp;L</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', marginTop: '8px', color: kpis.totalPnl >= 0 ? 'var(--gain)' : 'var(--loss)' }}>{formatSigned(kpis.totalPnl)}</div>
              <Sparkline data={kpis.spark} tone={kpis.totalPnl >= 0 ? 'var(--gain)' : 'var(--loss)'} width={74} height={26} />
            </Card>
            <Card stat tone="var(--accent)">
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Profit Factor</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', marginTop: '8px', color: 'var(--accent)' }}>
                {kpis.profitFactor == null ? '—' : kpis.profitFactor === Infinity ? '∞' : kpis.profitFactor.toFixed(2)}
              </div>
            </Card>
            <Card stat tone="var(--gain)">
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Best Trade</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', marginTop: '8px', color: 'var(--gain)' }}>{kpis.bestTrade != null ? formatSigned(kpis.bestTrade) : '—'}</div>
            </Card>
            <Card stat tone="var(--loss)">
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Worst Trade</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', marginTop: '8px', color: 'var(--loss)' }}>{kpis.worstTrade != null ? formatSigned(kpis.worstTrade) : '—'}</div>
            </Card>
            <Card stat tone="var(--gain)">
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Avg Win</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', marginTop: '8px', color: 'var(--gain)' }}>{kpis.avgWin != null ? formatSigned(kpis.avgWin) : '—'}</div>
            </Card>
            <Card stat tone="var(--loss)">
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Avg Loss</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', marginTop: '8px', color: 'var(--loss)' }}>{kpis.avgLoss != null ? formatSigned(kpis.avgLoss) : '—'}</div>
            </Card>
          </div>

          <Card ruled title="Equity Curve" style={{ marginBottom: '20px' }}>
            {kpis.cumulative.length > 1 ? (
              <EquityCurveChart data={kpis.cumulative} height={200} tone={kpis.totalPnl >= 0 ? 'var(--gain)' : 'var(--loss)'} />
            ) : (
              <div style={{ textAlign: 'center', padding: '48px', color: 'var(--muted)', fontSize: '13px' }}>Not enough closed trades yet for a curve.</div>
            )}
          </Card>

          <ListToolbar
            searchValue={search}
            onSearchChange={setSearch}
            placeholder="Search closed trades…"
            actions={(
              <button
                onClick={() => exportTradesToCSV(filtered, selectedAccount?.account_type, selectedAccount?.account_size)}
                className="lx-btn"
                style={{ padding: '8px 12px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                {renderIcon('download', { size: 13 })} Export CSV
              </button>
            )}
          />
          <FilterChips options={instrumentChips} activeId={instrumentFilter} onChange={setInstrumentFilter} />
          <FilterChips options={OUTCOME_CHIPS} activeId={outcomeFilter} onChange={setOutcomeFilter} />

          <Card ruled flush title="Closed Trades">
            {/* Eight columns do not fit a phone, and this is a list of records
                rather than a matrix — so below `md` each trade becomes a card
                (Table mobileCard) instead of a sideways scroll. */}
            <Table
              columns={TRADE_COLUMNS}
              rows={paged}
              mobileCard
              onRowClick={setDrawerTrade}
              emptyMessage="No closed trades match your filters"
            />
          </Card>

          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} pageSize={PAGE_SIZE} total={filtered.length} />
        </>
      )}

      {accountHistory.length > 0 && (
        <div style={{ marginTop: '32px' }}>
          <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: '12px' }}>
            Past Challenge Accounts
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {accountHistory.map((acc) => {
              const pnl = parseFloat(acc.total_pnl || 0)
              const statusColor = getStatusColor(acc.status)
              return (
                <Card key={acc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ fontSize: '13px' }}>
                    {String(acc.account_type).toUpperCase()} — ${parseFloat(acc.account_size).toLocaleString('en-US')}
                    <span style={{ color: statusColor, marginLeft: '10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>{String(acc.status).toUpperCase()}</span>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: pnl >= 0 ? 'var(--gain)' : 'var(--loss)' }}>{formatSigned(pnl)}</div>
                </Card>
              )
            })}
          </div>
        </div>
      )}

      <Drawer open={!!drawerTrade} onClose={() => setDrawerTrade(null)} title={drawerTrade?.instrument} subtitle={drawerTrade ? `Trade #${drawerTrade.id}` : ''}>
        {drawerTrade && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[
              ['Direction', drawerTrade.direction?.toUpperCase()],
              ['Lots', parseFloat(drawerTrade.lot_size).toFixed(2)],
              ['Open Price', drawerTrade.open_price],
              ['Close Price', drawerTrade.close_price],
              ['Stop Loss', drawerTrade.stop_loss || '—'],
              ['Take Profit', drawerTrade.take_profit || '—'],
              ['R-Multiple', drawerTrade.r_multiple != null ? `${drawerTrade.r_multiple.toFixed(2)}R` : 'No stop-loss set'],
              ['Close Reason', drawerTrade.close_reason || '—'],
              ['Opened', drawerTrade.open_time ? new Date(drawerTrade.open_time).toLocaleString() : '—'],
              ['Closed', drawerTrade.close_time ? new Date(drawerTrade.close_time).toLocaleString() : '—'],
              ['P&L', formatSigned(parseFloat(drawerTrade.demo_pnl || 0))],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--rule-soft)', paddingBottom: '8px' }}>
                <span style={{ color: 'var(--muted)', fontSize: '12.5px' }}>{label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}>{value}</span>
              </div>
            ))}
            {(drawerTrade.open_screenshot_url || drawerTrade.close_screenshot_url) && (
              <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
                {drawerTrade.open_screenshot_url && (
                  <a href={`${API_URL}${drawerTrade.open_screenshot_url}`} target="_blank" rel="noreferrer" className="lx-btn" style={{ padding: '8px 12px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)' }}>
                    {renderIcon('file', { size: 13 })} Open screenshot
                  </a>
                )}
                {drawerTrade.close_screenshot_url && (
                  <a href={`${API_URL}${drawerTrade.close_screenshot_url}`} target="_blank" rel="noreferrer" className="lx-btn" style={{ padding: '8px 12px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)' }}>
                    {renderIcon('file', { size: 13 })} Close screenshot
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  )
}
