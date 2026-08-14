import React, { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import CountUp from 'react-countup'
import { PageWrapper } from '../App'
import { renderIcon } from '../utils/iconMap'
import { formatPrice } from '../utils/instruments'
import Card from '../components/ui/Card'
import { API_BASE_URL as API_URL } from '../config/apiBase'


const CURVE_RANGES = [
  { id: 'day', label: '1D' },
  { id: 'week', label: '1W' },
  { id: 'month', label: '1M' },
  { id: 'full', label: 'Full Challenge' }
]

function formatDuration(mins) {
  const numeric = Number(mins || 0)
  if (!numeric) return '-'
  if (numeric < 60) return `${numeric.toFixed(0)}m`
  if (numeric < 1440) return `${(numeric / 60).toFixed(1)}h`
  return `${(numeric / 1440).toFixed(1)}d`
}

function formatAnimatedSignedCurrency(value) {
  const numericValue = Number(value || 0)
  return `${numericValue >= 0 ? '+' : '-'}$${Math.abs(numericValue).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatSignedCurrency(value) {
  const numericValue = Number(value || 0)
  return `${numericValue >= 0 ? '+' : '-'}$${Math.abs(numericValue).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatCurrency(value) {
  return `$${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatHistoryDate(value) {
  if (!value) return '-'
  return new Date(value).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatStrategyLabel(value) {
  if (!value) return 'Unlabeled'
  return String(value)
    .replace(/[_-]+/g, ' ')
    .trim()
}

function formatPercent(value, digits = 1) {
  return `${Number(value || 0).toFixed(digits)}%`
}

function getScoreColor(score) {
  if (score >= 85) return 'var(--green)'
  if (score >= 70) return 'var(--accent)'
  if (score >= 55) return 'var(--warn)'
  return 'var(--red)'
}

function exportExecutionsToCSV(trades) {
  if (!trades || trades.length === 0) return
  const headers = ['ID', 'Instrument', 'Direction', 'Lots', 'Open Price', 'Close Price', 'Close Time', 'R-Multiple', 'P&L']
  const rows = trades.map((t) => [
    t.id,
    t.instrument,
    t.direction,
    parseFloat(t.lot_size).toFixed(2),
    t.open_price ? formatPrice(t.open_price, t.instrument) : '',
    t.close_price ? formatPrice(t.close_price, t.instrument) : '',
    t.close_time ? new Date(t.close_time).toISOString() : '',
    t.r_multiple != null ? t.r_multiple.toFixed(2) : '',
    t.demo_pnl ? parseFloat(t.demo_pnl).toFixed(2) : '0.00',
  ])
  function csvSafeValue(val) {
    let str = String(val).replace(/"/g, '""')
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str
    return `"${str}"`
  }
  const csvContent = [headers, ...rows].map((row) => row.map(csvSafeValue).join(',')).join('\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `best_worst_executions_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function getCellBackground(slot, maxAbsPnl, maxTrades) {
  const pnl = Number(slot?.pnl || 0)
  const trades = Number(slot?.trades || 0)
  if (!trades) return 'var(--glass)'

  const pnlWeight = maxAbsPnl > 0 ? Math.min(Math.abs(pnl) / maxAbsPnl, 1) : 0
  const tradeWeight = maxTrades > 0 ? Math.min(trades / maxTrades, 1) : 0
  const opacity = Math.max(0.12, Math.min(0.9, (pnlWeight * 0.65) + (tradeWeight * 0.35)))

  if (pnl > 0) return `color-mix(in srgb, var(--gain) ${opacity * 100}%, transparent)`
  if (pnl < 0) return `color-mix(in srgb, var(--loss) ${opacity * 100}%, transparent)`
  return `color-mix(in srgb, var(--muted) ${Math.max(0.08, opacity * 0.55) * 100}%, transparent)`
}

function SectionHeader({ title, subtitle, action }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
      <div>
        <h3 style={{ color: 'var(--accent)', marginBottom: '4px', fontSize: '15px' }}>{title}</h3>
        {subtitle && <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: 0 }}>{subtitle}</p>}
      </div>
      {action || null}
    </div>
  )
}

function StatCard({ label, children, accentColor }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={accentColor ? { color: accentColor } : undefined}>
        {children}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function BreakdownCard({ title, subtitle, rows }) {
  const items = Array.isArray(rows) ? rows.slice(0, 6) : []

  return (
    <Card>
      <SectionHeader title={title} subtitle={subtitle} />
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Not enough trades yet.</div>
      ) : (
        <div style={{ display: 'grid', gap: '10px' }}>
          {items.map((row) => (
            <div
              key={`${title}-${row.key || row.label}`}
              style={{
                border: '1px solid var(--navy-border)',
                borderRadius: '0',
                padding: '12px 14px',
                background: 'var(--glass)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <div>
                  <div style={{ color: 'var(--text)', fontWeight: '700', fontSize: '13px' }}>{formatStrategyLabel(row.label)}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '3px' }}>
                    {row.trades} trades | {row.wins} wins | {row.losses} losses
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: Number(row.total_pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
                    {formatSignedCurrency(row.total_pnl || 0)}
                  </div>
                  <div style={{ color: Number(row.win_rate || 0) >= 50 ? 'var(--green)' : 'var(--red)', fontSize: '11px', marginTop: '3px' }}>
                    {formatPercent(row.win_rate || 0)} win rate
                  </div>
                </div>
              </div>
              {row.avg_hold_mins != null && (
                <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
                  Avg hold {formatDuration(row.avg_hold_mins)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function ScorePanel({ title, score, grade, summary, components, metrics }) {
  const componentRows = Object.entries(components || {})
  const metricRows = Object.entries(metrics || {})

  return (
    <Card>
      <SectionHeader
        title={title}
        subtitle={summary}
        action={(
          <div style={{
            minWidth: '82px',
            padding: '10px 12px',
            borderRadius: '0',
            border: `1px solid ${getScoreColor(score)}`,
            background: 'var(--glass)',
            textAlign: 'center'
          }}>
            <div style={{ color: getScoreColor(score), fontSize: '24px', fontWeight: '800', lineHeight: 1 }}>{score}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>Grade {grade}</div>
          </div>
        )}
      />
      <div style={{ display: 'grid', gap: '10px', marginBottom: metricRows.length > 0 ? '14px' : 0 }}>
        {componentRows.map(([key, value]) => (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '5px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{formatStrategyLabel(key)}</span>
              <span style={{ fontSize: '12px', color: getScoreColor(value), fontWeight: '700' }}>{value}/100</span>
            </div>
            <div style={{ height: '10px', borderRadius: 'var(--radius-pill)', overflow: 'hidden', background: 'var(--navy)', border: '1px solid var(--navy-border)' }}>
              <div style={{
                width: `${Math.max(0, Math.min(100, value))}%`,
                height: '100%',
                background: getScoreColor(value)
              }} />
            </div>
          </div>
        ))}
      </div>
      {metricRows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' }}>
          {metricRows.map(([key, value]) => (
            <div key={key} style={{ padding: '10px 12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {formatStrategyLabel(key)}
              </div>
              <div style={{ marginTop: '5px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontWeight: '700' }}>
                {typeof value === 'number' ? value.toFixed(1).replace(/\.0$/, '') : String(value)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

export default function Analytics({ selectedAccount }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [replayIndex, setReplayIndex] = useState(100)
  const [curveRange, setCurveRange] = useState('full')
  const [hoveredHeatCell, setHoveredHeatCell] = useState(null)
  const canvasRef = useRef(null)
  const dataRef = useRef(data)

  useEffect(() => {
    dataRef.current = data
  }, [data])

  const getActiveCurve = useCallback((analyticsPayload) => {
    const ranges = analyticsPayload?.equity_curve_ranges || {}
    const preferred = Array.isArray(ranges[curveRange]) ? ranges[curveRange] : []
    if (preferred.length > 0) return preferred
    return Array.isArray(ranges.full) && ranges.full.length > 0
      ? ranges.full
      : (analyticsPayload?.drawdown_curve || [])
  }, [curveRange])

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current
    const currentData = dataRef.current
    const activeCurve = getActiveCurve(currentData?.analytics)
    if (!canvas || !activeCurve?.length) return

    const ctx = canvas.getContext('2d')
    const curve = activeCurve.slice(0, Math.max(1, Math.floor(activeCurve.length * (replayIndex / 100))))

    // Resolve Ledger Desk tokens at draw time (canvas can't read CSS vars directly).
    const readToken = (name, fallback) => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      return value || fallback
    }
    const tokens = {
      rule: readToken('--rule', '#3a3a3a'),
      muted: readToken('--muted', '#8a8a82'),
      ink: readToken('--ink', '#e8e4d8'),
      gain: readToken('--gain', '#4ade80'),
      loss: readToken('--loss', '#f87171')
    }

    const width = canvas.width = canvas.offsetWidth
    const height = canvas.height = 240
    ctx.clearRect(0, 0, width, height)

    const balances = curve.map((point) => Number(point.balance || 0))
    const minBalance = Math.min(...balances)
    const maxBalance = Math.max(...balances)
    const range = maxBalance - minBalance || 1

    const pad = { top: 20, right: 20, bottom: 40, left: 70 }
    const chartWidth = width - pad.left - pad.right
    const chartHeight = height - pad.top - pad.bottom

    ctx.strokeStyle = tokens.rule
    ctx.lineWidth = 1
    for (let index = 0; index <= 4; index += 1) {
      const y = pad.top + (chartHeight / 4) * index
      ctx.beginPath()
      ctx.moveTo(pad.left, y)
      ctx.lineTo(width - pad.right, y)
      ctx.stroke()
    }

    ctx.fillStyle = tokens.muted
    ctx.font = '11px "Public Sans", sans-serif'
    ctx.textAlign = 'right'
    for (let index = 0; index <= 4; index += 1) {
      const value = maxBalance - (range / 4) * index
      const y = pad.top + (chartHeight / 4) * index
      ctx.fillText(`$${value.toFixed(0)}`, pad.left - 8, y + 4)
    }

    ctx.textAlign = 'center'
    const step = Math.max(1, Math.ceil(curve.length / 5))
    curve.forEach((point, index) => {
      if (index % step === 0 || index === curve.length - 1) {
        const x = pad.left + (index / Math.max(curve.length - 1, 1)) * chartWidth
        const y = height - pad.bottom + 16
        const date = new Date(point.date)
        ctx.fillText(`${date.getMonth() + 1}/${date.getDate()}`, x, y)
      }
    })

    const points = curve.map((point, index) => ({
      x: pad.left + (index / Math.max(curve.length - 1, 1)) * chartWidth,
      y: pad.top + chartHeight - ((Number(point.balance || 0) - minBalance) / range) * chartHeight
    }))

    ctx.beginPath()
    ctx.strokeStyle = tokens.ink
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.stroke()

    points.forEach((point, index) => {
      const previousBalance = index > 0
        ? Number(curve[index - 1].balance || 0)
        : Number(currentData?.account?.starting_balance || 0)
      const pnl = Number(curve[index].balance || 0) - previousBalance
      ctx.beginPath()
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = pnl >= 0 ? tokens.gain : tokens.loss
      ctx.fill()
    })
  }, [curveRange, getActiveCurve, replayIndex])

  const fetchAnalytics = useCallback(async () => {
    if (!selectedAccount?.id) return
    setLoading(true)
    setError('')
    try {
      const res = await axios.get(`${API_URL}/api/trades/analytics`, {
        params: { account_id: selectedAccount.id }
      })
      setData(res.data)
    } catch {
      setError('Could not load analytics')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount?.id])

  useEffect(() => {
    fetchAnalytics()
  }, [fetchAnalytics])

  // Raw closed trades, for the "Best & Worst Executions" table — /analytics
  // only returns aggregates, so this is a separate light fetch. /history
  // returns a plain array (all non-open/pending trades, incl. cancelled).
  const [closedTrades, setClosedTrades] = useState([])
  useEffect(() => {
    if (!selectedAccount?.id) { setClosedTrades([]); return }
    let cancelled = false
    axios.get(`${API_URL}/api/trades/history`, {
      params: { account_id: selectedAccount.id }
    }).then((res) => {
      const rows = Array.isArray(res.data) ? res.data : []
      if (!cancelled) setClosedTrades(rows.filter((t) => t.status === 'closed'))
    }).catch(() => { if (!cancelled) setClosedTrades([]) })
    return () => { cancelled = true }
  }, [selectedAccount?.id])

  useEffect(() => {
    if (data?.analytics) {
      drawChart()
      const canvas = canvasRef.current
      if (!canvas) return undefined
      const observer = new ResizeObserver(() => drawChart())
      observer.observe(canvas.parentElement)
      return () => observer.disconnect()
    }
    return undefined
  }, [data, drawChart, curveRange, replayIndex])

  if (!selectedAccount) {
    return (
      <PageWrapper>
        <Card className="analytics-page" style={{ textAlign: 'center', padding: '48px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('analytics', { size: 48, color: 'var(--accent)' })}
          </div>
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Account Selected</h3>
          <p style={{ color: 'var(--text-muted)' }}>Select an account from the Dashboard to view analytics.</p>
        </Card>
      </PageWrapper>
    )
  }

  if (loading) {
    return (
      <PageWrapper>
        <div style={{ textAlign: 'center', padding: '80px', color: 'var(--text-muted)' }}>
          Loading analytics...
        </div>
      </PageWrapper>
    )
  }

  if (error) {
    return (
      <PageWrapper>
        <div className="error">{error}</div>
      </PageWrapper>
    )
  }

  if (!data?.analytics) {
    return null
  }

  const { analytics, account } = data
  const hasData = Number(analytics.total_trades || 0) > 0

  if (!hasData) {
    return (
      <PageWrapper>
        <div className="analytics-page">
          <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '8px', fontSize: '22px' }}>
            Analytics
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '24px' }}>
            {selectedAccount.account_type.toUpperCase()} - ${parseFloat(selectedAccount.account_size).toLocaleString('en-US')}
          </p>
          <Card style={{ textAlign: 'center', padding: '48px' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              {renderIcon('file', { size: 48, color: 'var(--text-secondary)' })}
            </div>
            <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Closed Trades Yet</h3>
            <p style={{ color: 'var(--text-muted)' }}>
              Close some trades to unlock the performance dashboard, behavior scoring, and payout readiness forecast.
            </p>
          </Card>
        </div>
      </PageWrapper>
    )
  }

  const breakdowns = analytics.breakdowns || {}
  const holdTime = analytics.hold_time || {}
  const setupReport = analytics.setup_report || {}
  const discipline = analytics.discipline_score || {}
  const riskConsistency = analytics.risk_consistency_score || {}
  const breachAnalysis = analytics.breach_analysis || {}
  const payoutForecast = analytics.payout_forecast || {}
  const suggestions = Array.isArray(analytics.improvement_suggestions) ? analytics.improvement_suggestions : []
  const activityHeatmap = analytics.activity_heatmap || { hours: [], matrix: [] }
  const heatmapHours = Array.isArray(activityHeatmap.hours) ? activityHeatmap.hours : []
  const heatmapMatrix = Array.isArray(activityHeatmap.matrix) ? activityHeatmap.matrix : []
  const maxAbsPnl = heatmapMatrix.reduce((best, row) => Math.max(best, ...(row.slots || []).map((slot) => Math.abs(Number(slot.pnl || 0)))), 0)
  const maxTrades = heatmapMatrix.reduce((best, row) => Math.max(best, ...(row.slots || []).map((slot) => Number(slot.trades || 0))), 0)
  const activeCurve = getActiveCurve(analytics)

  return (
    <PageWrapper>
      <div className="analytics-page">
        <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '8px', fontSize: '22px' }}>
          Analytics
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '24px' }}>
          {selectedAccount.account_type.toUpperCase()} - ${parseFloat(selectedAccount.account_size).toLocaleString('en-US')}
        </p>

        {/* ── Prototype-matched headline strip (Modern Gazette handoff spec,
            isAnalytics block) — kept alongside, not replacing, the richer
            stat grids/breakdowns below per explicit decision. ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(186px,1fr))', gap: '12px', marginBottom: '16px' }}>
          {[
            { label: 'Profit factor', value: Number.isFinite(analytics.profit_factor) ? analytics.profit_factor.toFixed(2) : '—', tone: 'var(--gain)', sub: 'Gross win ÷ gross loss' },
            { label: 'Expectancy', value: formatSignedCurrency(analytics.expectancy || 0), tone: (analytics.expectancy || 0) >= 0 ? 'var(--gain)' : 'var(--loss)', sub: `Per trade, ${analytics.total_trades || 0} trades` },
            { label: 'Avg win / loss', value: analytics.avg_rr ? `${analytics.avg_rr.toFixed(1)} : 1` : '—', tone: 'var(--ink)', sub: `${formatCurrency(analytics.avg_win || 0)} vs ${formatCurrency(analytics.avg_loss || 0)}` },
            { label: 'Sharpe (30d)', value: analytics.sharpe_30d != null ? analytics.sharpe_30d.toFixed(2) : '—', tone: 'var(--accent)', sub: 'Daily, unannualised' },
            { label: 'Best streak', value: `${analytics.best_win_streak || 0} wins`, tone: 'var(--warn)', sub: 'Consecutive closed trades' },
          ].map((k) => (
            <Card key={k.label} stat tone={k.tone}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>{k.label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: '23px', marginTop: '8px', color: k.tone }}>{k.value}</div>
              <div style={{ fontSize: '11.5px', color: 'var(--muted)', marginTop: '4px' }}>{k.sub}</div>
            </Card>
          ))}
        </div>

        {(breakdowns.weekday?.length > 0 || breakdowns.symbol?.length > 0) && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: '16px', marginBottom: '20px', alignItems: 'start' }}>
            <Card ruled eyebrow="Realised P&L" title="By Day of Week">
              {(() => {
                const rows = [...(breakdowns.weekday || [])].sort((a, b) => a.order - b.order)
                const maxAbs = rows.reduce((best, r) => Math.max(best, Math.abs(r.total_pnl || 0)), 1)
                return (
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', height: '200px', paddingTop: '10px' }}>
                    {rows.map((r) => {
                      const pnl = r.total_pnl || 0
                      const heightPct = Math.max(4, (Math.abs(pnl) / maxAbs) * 100)
                      const tone = pnl > 0 ? 'var(--gain)' : pnl < 0 ? 'var(--loss)' : 'var(--muted)'
                      return (
                        <div key={r.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: tone, marginBottom: '6px' }}>{formatSignedCurrency(pnl)}</div>
                          <div style={{ width: '100%', height: `${heightPct}%`, background: tone, borderRadius: '2px 2px 0 0', minHeight: '3px' }} />
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: '8px' }}>{r.label.slice(0, 3)}</div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </Card>

            <Card title="Instrument Mix" eyebrow={`Share of volume · ${analytics.total_trades || 0} trades`}>
              {(() => {
                const tones = ['var(--accent)', 'var(--gain)', 'var(--warn)', 'var(--loss)', 'var(--muted)']
                const rows = [...(breakdowns.symbol || [])].sort((a, b) => b.trades - a.trades).slice(0, 5)
                const total = rows.reduce((sum, r) => sum + r.trades, 0) || 1
                return (
                  <div>
                    {rows.map((r, i) => {
                      const share = (r.trades / total) * 100
                      const tone = tones[i % tones.length]
                      return (
                        <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '7px 0', borderBottom: '1px solid var(--rule-soft)' }}>
                          <span style={{ width: '9px', height: '9px', background: tone, flex: '0 0 auto' }} />
                          <span style={{ flex: 1, fontSize: '12.5px' }}>{r.label}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--muted)' }}>{share.toFixed(0)}%</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: (r.total_pnl || 0) >= 0 ? 'var(--gain)' : 'var(--loss)', minWidth: '64px', textAlign: 'right' }}>{formatSignedCurrency(r.total_pnl || 0)}</span>
                        </div>
                      )
                    })}
                    {rows.length === 0 && <div style={{ color: 'var(--muted)', fontSize: '12px' }}>Not enough trades yet.</div>}
                  </div>
                )
              })()}
            </Card>
          </div>
        )}

        {Array.isArray(analytics.r_distribution) && analytics.r_distribution.length > 0 && (
          <Card title="R-Multiple Distribution" eyebrow="Closed trades · risk-normalised" style={{ marginBottom: '20px' }}>
            {(() => {
              const buckets = [
                { label: '< -2R', test: (r) => r < -2 },
                { label: '-2 to -1R', test: (r) => r >= -2 && r < -1 },
                { label: '-1 to 0R', test: (r) => r >= -1 && r < 0 },
                { label: '0 to 1R', test: (r) => r >= 0 && r < 1 },
                { label: '1 to 2R', test: (r) => r >= 1 && r < 2 },
                { label: '> 2R', test: (r) => r >= 2 },
              ].map((b) => ({ ...b, count: analytics.r_distribution.filter(b.test).length }))
              const maxCount = buckets.reduce((best, b) => Math.max(best, b.count), 1)
              return (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', height: '180px', paddingTop: '10px' }}>
                  {buckets.map((b) => {
                    const heightPct = Math.max(4, (b.count / maxCount) * 100)
                    const tone = b.label.includes('-') ? 'var(--loss)' : 'var(--gain)'
                    return (
                      <div key={b.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: tone, marginBottom: '6px' }}>{b.count}</div>
                        <div style={{ width: '100%', height: `${heightPct}%`, background: tone, borderRadius: '2px 2px 0 0', minHeight: '3px' }} />
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '.06em', color: 'var(--muted)', marginTop: '8px', textAlign: 'center' }}>{b.label}</div>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </Card>
        )}

        {closedTrades.length > 0 && (() => {
          const sorted = [...closedTrades].sort((a, b) => parseFloat(b.demo_pnl || 0) - parseFloat(a.demo_pnl || 0))
          const best = sorted.slice(0, 5)
          const worst = sorted.slice(-5).reverse()
          const executions = [...best, ...worst]
          return (
            <Card
              ruled
              eyebrow="Closed trades"
              title="Best & Worst Executions"
              actions={
                <button
                  type="button"
                  className="lx-btn"
                  onClick={() => exportExecutionsToCSV(executions)}
                  style={{ padding: '8px 12px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  Export CSV
                </button>
              }
              flush
              style={{ marginBottom: '20px' }}
            >
              <table className="lx-table">
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Direction</th>
                    <th>Lots</th>
                    <th>Open</th>
                    <th>Close</th>
                    <th>Closed</th>
                    <th>R-Multiple</th>
                    <th>P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {best.map((t) => (
                    <tr key={`best-${t.id}`}>
                      <td>{t.instrument}</td>
                      <td><span className="lx-badge" style={{ color: 'var(--gain)' }}>{t.direction}</span></td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{parseFloat(t.lot_size).toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{t.open_price ? formatPrice(t.open_price, t.instrument) : '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{t.close_price ? formatPrice(t.close_price, t.instrument) : '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--muted)' }}>{formatHistoryDate(t.close_time)}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{t.r_multiple != null ? `${t.r_multiple.toFixed(2)}R` : '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--gain)' }}>{formatSignedCurrency(t.demo_pnl)}</td>
                    </tr>
                  ))}
                  {worst.map((t) => (
                    <tr key={`worst-${t.id}`}>
                      <td>{t.instrument}</td>
                      <td><span className="lx-badge" style={{ color: 'var(--loss)' }}>{t.direction}</span></td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{parseFloat(t.lot_size).toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{t.open_price ? formatPrice(t.open_price, t.instrument) : '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{t.close_price ? formatPrice(t.close_price, t.instrument) : '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--muted)' }}>{formatHistoryDate(t.close_time)}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{t.r_multiple != null ? `${t.r_multiple.toFixed(2)}R` : '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--loss)' }}>{formatSignedCurrency(t.demo_pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )
        })()}

        <div className="grid-4" style={{ marginBottom: '16px' }}>
          <StatCard label="Total Trades">
            <CountUp end={analytics.total_trades || 0} duration={1.2} separator="," preserveValue={true} useEasing={true} />
          </StatCard>
          <StatCard label="Win Rate" accentColor={Number(analytics.win_rate || 0) >= 50 ? 'var(--green)' : 'var(--red)'}>
            <CountUp end={analytics.win_rate || 0} decimals={1} duration={1.2} preserveValue={true} useEasing={true} />
            %
          </StatCard>
          <StatCard label="Total P&L" accentColor={Number(analytics.total_pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)'}>
            <CountUp
              end={analytics.total_pnl || 0}
              decimals={2}
              duration={1.2}
              separator=","
              preserveValue={true}
              useEasing={true}
              formattingFn={formatAnimatedSignedCurrency}
            />
          </StatCard>
          <StatCard label="Avg Hold Time">
            {formatDuration(analytics.avg_trade_duration_mins)}
          </StatCard>
        </div>

        <div className="grid-4" style={{ marginBottom: '20px' }}>
          <StatCard label="Best Trade" accentColor="var(--green)">
            {formatSignedCurrency(analytics.best_trade || 0)}
          </StatCard>
          <StatCard label="Worst Trade" accentColor="var(--red)">
            {formatSignedCurrency(analytics.worst_trade || 0)}
          </StatCard>
          <StatCard label="Discipline Score" accentColor={getScoreColor(discipline.score || 0)}>
            {(discipline.score || 0)}/100
          </StatCard>
          <StatCard label="Risk Consistency" accentColor={getScoreColor(riskConsistency.score || 0)}>
            {(riskConsistency.score || 0)}/100
          </StatCard>
        </div>

        <Card style={{ marginBottom: '20px', padding: '20px' }}>
          <SectionHeader
            title="Equity Curve"
            subtitle={`Zoom across the latest ${activeCurve.length} closed-trade points. Replay keeps working inside each range.`}
            action={(
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {CURVE_RANGES.map((range) => (
                  <button
                    key={range.id}
                    onClick={() => setCurveRange(range.id)}
                    style={{
                      padding: '7px 12px',
                      borderRadius: 'var(--radius-pill)',
                      border: curveRange === range.id ? '1px solid var(--accent)' : '1px solid var(--navy-border)',
                      background: curveRange === range.id ? 'rgba(var(--brand-primary-rgb),0.16)' : 'transparent',
                      color: curveRange === range.id ? 'var(--accent)' : 'var(--text-muted)',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: '700'
                    }}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
            )}
          />

          <div style={{ position: 'relative', width: '100%' }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '240px', display: 'block' }} />
            <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Equity Replay</span>
              <input
                type="range"
                min="1"
                max="100"
                value={replayIndex}
                onChange={(e) => {
                  setReplayIndex(Number(e.target.value))
                  drawChart()
                }}
                style={{ flex: 1, accentColor: 'var(--accent)' }}
              />
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{replayIndex}%</span>
            </div>
          </div>
        </Card>

        <div className="grid-2" style={{ marginBottom: '20px' }}>
          <BreakdownCard
            title="Win Rate by Symbol"
            subtitle="Which instruments pay you and which ones bleed."
            rows={breakdowns.symbol}
          />
          <BreakdownCard
            title="Win Rate by Weekday"
            subtitle="See if there are good days to press and bad days to stay lighter."
            rows={breakdowns.weekday}
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <BreakdownCard
            title="Win Rate by Session"
            subtitle="Performance split across Asia, London, New York, and rollover hours."
            rows={breakdowns.session}
          />
        </div>

        <div className="grid-2" style={{ marginBottom: '20px' }}>
          <Card>
            <SectionHeader
              title="Hold-Time Analytics"
              subtitle={holdTime.bias_label}
            />

            <div className="grid-4" style={{ marginBottom: '14px' }}>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Average</div>
                <div style={{ marginTop: '6px', fontSize: '18px', fontWeight: '700', color: 'var(--text)' }}>{formatDuration(holdTime.average_mins)}</div>
              </div>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Median</div>
                <div style={{ marginTop: '6px', fontSize: '18px', fontWeight: '700', color: 'var(--text)' }}>{formatDuration(holdTime.median_mins)}</div>
              </div>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Winners Avg</div>
                <div style={{ marginTop: '6px', fontSize: '18px', fontWeight: '700', color: 'var(--green)' }}>{formatDuration(holdTime.winners_average_mins)}</div>
              </div>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Losers Avg</div>
                <div style={{ marginTop: '6px', fontSize: '18px', fontWeight: '700', color: 'var(--red)' }}>{formatDuration(holdTime.losers_average_mins)}</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                  Quick exits inside {holdTime.quick_exit_threshold_mins || 0}m
                </div>
                <div style={{ fontSize: '20px', fontWeight: '700', color: holdTime.quick_exit_rate >= 35 ? 'var(--red)' : 'var(--green)' }}>
                  {formatPercent(holdTime.quick_exit_rate || 0)}
                </div>
              </div>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                  Over-holds beyond {formatDuration(holdTime.overhold_threshold_mins)}
                </div>
                <div style={{ fontSize: '20px', fontWeight: '700', color: holdTime.overhold_rate >= 35 ? 'var(--red)' : 'var(--green)' }}>
                  {formatPercent(holdTime.overhold_rate || 0)}
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <SectionHeader
              title="Best and Worst Setups"
              subtitle="A quick report on the strongest and weakest recurring patterns."
            />
            <div style={{ display: 'grid', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--green)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>Best Setups</div>
                <div style={{ display: 'grid', gap: '10px' }}>
                  {(setupReport.best_setups || []).map((entry) => (
                    <div key={`best-${entry.setup_type}-${entry.key}`} style={{ padding: '12px 14px', borderRadius: '0', border: '1px solid var(--green)', background: 'var(--success-bg)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                        <div>
                          <div style={{ color: 'var(--text)', fontSize: '13px', fontWeight: '700' }}>{formatStrategyLabel(entry.label)}</div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '3px' }}>{entry.setup_type} | {entry.trades} trades</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ color: 'var(--green)', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>{formatSignedCurrency(entry.total_pnl)}</div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '3px' }}>{formatPercent(entry.win_rate)} win</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '11px', color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>Worst Setups</div>
                <div style={{ display: 'grid', gap: '10px' }}>
                  {(setupReport.worst_setups || []).map((entry) => (
                    <div key={`worst-${entry.setup_type}-${entry.key}`} style={{ padding: '12px 14px', borderRadius: '0', border: '1px solid var(--red)', background: 'var(--danger-bg)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                        <div>
                          <div style={{ color: 'var(--text)', fontSize: '13px', fontWeight: '700' }}>{formatStrategyLabel(entry.label)}</div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '3px' }}>{entry.setup_type} | {entry.trades} trades</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ color: 'var(--red)', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>{formatSignedCurrency(entry.total_pnl)}</div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '3px' }}>{formatPercent(entry.win_rate)} win</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </div>

        <Card style={{ marginBottom: '20px' }}>
          <SectionHeader
            title="Hour and Day Heatmap"
            subtitle="Trading activity and profitability concentration across the week."
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
            {Array.isArray(activityHeatmap.weekday_summary) && activityHeatmap.weekday_summary.slice(0, 3).map((row) => (
              <div key={`weekday-${row.label}`} style={{ padding: '12px 14px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Best Weekday Pocket</div>
                <div style={{ marginTop: '5px', color: 'var(--text)', fontWeight: '700' }}>{row.label}</div>
                <div style={{ marginTop: '4px', color: Number(row.total_pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)' }}>
                  {formatSignedCurrency(row.total_pnl || 0)}
                </div>
              </div>
            ))}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '980px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '100px repeat(24, minmax(28px, 1fr))', gap: '4px', marginBottom: '6px' }}>
                <div />
                {heatmapHours.map((hour) => (
                  <div key={`hour-header-${hour}`} style={{ textAlign: 'center', fontSize: '10px', color: 'var(--text-muted)' }}>
                    {hour}
                  </div>
                ))}
              </div>

              <div style={{ display: 'grid', gap: '4px' }}>
                {heatmapMatrix.map((row) => (
                  <div key={`heat-row-${row.day_label}`} style={{ display: 'grid', gridTemplateColumns: '100px repeat(24, minmax(28px, 1fr))', gap: '4px', alignItems: 'center' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {row.day_label} ({row.total_trades})
                    </div>
                    {(row.slots || []).map((slot) => {
                      const isHovered = hoveredHeatCell?.day === row.day_label && hoveredHeatCell?.hour === slot.hour
                      return (
                        <div
                          key={`${row.day_label}-${slot.hour}`}
                          onMouseEnter={() => setHoveredHeatCell({ day: row.day_label, hour: slot.hour, trades: slot.trades, pnl: slot.pnl })}
                          onMouseLeave={() => setHoveredHeatCell(null)}
                          style={{
                            height: '28px',
                            borderRadius: '0',
                            border: isHovered ? '1px solid var(--ink, var(--text))' : '1px solid var(--rule-soft)',
                            background: getCellBackground(slot, maxAbsPnl, maxTrades),
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--text)',
                            fontSize: '10px',
                            fontWeight: '700',
                            cursor: 'pointer'
                          }}
                        >
                          {slot.trades > 0 ? slot.trades : ''}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Read-out line — never a floating tooltip; the hovered cell's
              detail always renders here, pinned to the last-hovered cell's
              info when nothing is currently under the cursor. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px',
            borderTop: '1px solid var(--rule-soft)', paddingTop: '10px',
            fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-muted)'
          }}>
            {hoveredHeatCell ? (
              <>
                <span style={{ color: 'var(--text)' }}>{hoveredHeatCell.day} {String(hoveredHeatCell.hour).padStart(2, '0')}:00</span>
                <span>·</span>
                <span>{hoveredHeatCell.trades} trade{hoveredHeatCell.trades === 1 ? '' : 's'}</span>
                <span>·</span>
                <span style={{ color: Number(hoveredHeatCell.pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {formatSignedCurrency(hoveredHeatCell.pnl)}
                </span>
              </>
            ) : (
              <span>Hover a cell for detail</span>
            )}
          </div>
        </Card>

        <div className="grid-2" style={{ marginBottom: '20px' }}>
          <ScorePanel
            title="Discipline Score"
            score={discipline.score || 0}
            grade={discipline.grade || 'E'}
            summary={discipline.summary || 'No discipline summary available.'}
            components={discipline.components || {}}
            metrics={discipline.metrics || {}}
          />
          <ScorePanel
            title="Risk Consistency Score"
            score={riskConsistency.score || 0}
            grade={riskConsistency.grade || 'E'}
            summary={riskConsistency.summary || 'No risk consistency summary available.'}
            components={riskConsistency.components || {}}
            metrics={riskConsistency.metrics || {}}
          />
        </div>

        <div className="grid-2" style={{ marginBottom: '20px' }}>
          <Card>
            <SectionHeader
              title={breachAnalysis.title || 'Breach Analysis'}
              subtitle={breachAnalysis.explanation || 'No breach analysis available yet.'}
            />

            <div style={{ display: 'grid', gap: '12px', marginBottom: '14px' }}>
              <div style={{ padding: '12px 14px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Primary Cause</div>
                <div style={{ marginTop: '5px', fontSize: '16px', color: 'var(--text)', fontWeight: '700' }}>
                  {formatStrategyLabel(breachAnalysis.primary_cause)}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
                <div style={{ padding: '10px 12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Target Progress</div>
                  <div style={{ marginTop: '5px', fontWeight: '700', color: 'var(--accent)' }}>{formatPercent(breachAnalysis.target_progress_pct || 0)}</div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Drawdown Usage</div>
                  <div style={{ marginTop: '5px', fontWeight: '700', color: Number(breachAnalysis.drawdown_usage_pct || 0) >= 70 ? 'var(--red)' : 'var(--green)' }}>
                    {formatPercent(breachAnalysis.drawdown_usage_pct || 0)}
                  </div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Days Remaining</div>
                  <div style={{ marginTop: '5px', fontWeight: '700', color: 'var(--text)' }}>
                    {breachAnalysis.days_remaining == null ? '-' : breachAnalysis.days_remaining}
                  </div>
                </div>
              </div>
            </div>

            {Array.isArray(breachAnalysis.recent_violations) && breachAnalysis.recent_violations.length > 0 && (
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                  Recent Rule Warnings
                </div>
                <div style={{ display: 'grid', gap: '8px' }}>
                  {breachAnalysis.recent_violations.map((violation, index) => (
                    <div key={`violation-${index}`} style={{ padding: '10px 12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                      <div style={{ color: 'var(--text)', fontSize: '12px', fontWeight: '700' }}>
                        {formatStrategyLabel(violation.violation_type)}
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
                        {violation.message || 'No additional detail'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <Card>
            <SectionHeader
              title="Payout Readiness Forecast"
              subtitle={payoutForecast.next_status || 'No payout forecast available.'}
              action={(
                <div style={{
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-pill)',
                  border: `1px solid ${payoutForecast.eligible_now ? 'var(--green)' : 'var(--navy-border)'}`,
                  background: payoutForecast.eligible_now ? 'var(--success-bg)' : 'var(--glass)',
                  color: payoutForecast.eligible_now ? 'var(--green)' : 'var(--text-muted)',
                  fontSize: '11px',
                  fontWeight: '700',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase'
                }}>
                  {payoutForecast.eligible_now ? 'Eligible Now' : 'Not Ready'}
                </div>
              )}
            />

            <div className="grid-4" style={{ marginBottom: '14px' }}>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Estimated Payable</div>
                <div style={{ marginTop: '6px', fontSize: '18px', fontWeight: '700', color: Number(payoutForecast.estimated_payable || 0) >= Number(payoutForecast.min_request_amount || 0) ? 'var(--green)' : 'var(--red)' }}>
                  {formatCurrency(payoutForecast.estimated_payable || 0)}
                </div>
              </div>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Profit Share</div>
                <div style={{ marginTop: '6px', fontSize: '18px', fontWeight: '700', color: 'var(--text)' }}>{formatPercent(payoutForecast.profit_share_pct || 0, 0)}</div>
              </div>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Min Request</div>
                <div style={{ marginTop: '6px', fontSize: '18px', fontWeight: '700', color: 'var(--text)' }}>{formatCurrency(payoutForecast.min_request_amount || 0)}</div>
              </div>
              <div style={{ padding: '12px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Trend</div>
                <div style={{ marginTop: '6px', fontSize: '18px', fontWeight: '700', color: Number(payoutForecast.trend_pnl_last_5_trades || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {formatStrategyLabel(payoutForecast.trend_label)}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gap: '10px', marginBottom: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--navy-border)' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Recent trend (last 5 trades)</span>
                <span style={{ color: Number(payoutForecast.trend_pnl_last_5_trades || 0) >= 0 ? 'var(--green)' : 'var(--red)', fontSize: '12px', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
                  {formatSignedCurrency(payoutForecast.trend_pnl_last_5_trades || 0)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--navy-border)' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Profit gap to minimum request</span>
                <span style={{ color: 'var(--text)', fontSize: '12px', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
                  {formatCurrency(payoutForecast.profit_gap_to_min_request || 0)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--navy-border)' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>KYC status</span>
                <span style={{ color: String(payoutForecast.kyc_status || '').toLowerCase() === 'approved' ? 'var(--green)' : 'var(--red)', fontSize: '12px', fontWeight: '700' }}>
                  {formatStrategyLabel(payoutForecast.kyc_status)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Open exposure blockers</span>
                <span style={{ color: Number(payoutForecast.open_trade_count || 0) + Number(payoutForecast.pending_order_count || 0) > 0 ? 'var(--red)' : 'var(--green)', fontSize: '12px', fontWeight: '700' }}>
                  {Number(payoutForecast.open_trade_count || 0) + Number(payoutForecast.pending_order_count || 0)}
                </span>
              </div>
            </div>

            {Array.isArray(payoutForecast.blockers) && payoutForecast.blockers.length > 0 && (
              <div style={{ display: 'grid', gap: '8px' }}>
                {payoutForecast.blockers.map((blocker, index) => (
                  <div key={`blocker-${index}`} style={{ padding: '10px 12px', borderRadius: '0', border: '1px solid var(--red)', background: 'var(--danger-bg)', color: 'var(--text-muted)', fontSize: '12px' }}>
                    {blocker}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card style={{ marginBottom: '20px' }}>
          <SectionHeader
            title="AI-Style Improvement Suggestions"
            subtitle="Heuristic coaching based on your actual results, behavior, and payout readiness."
          />

          <div style={{ display: 'grid', gap: '12px' }}>
            {suggestions.map((suggestion, index) => (
              <div key={`suggestion-${index}`} style={{ padding: '14px 16px', borderRadius: '0', border: '1px solid var(--navy-border)', background: 'var(--glass)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ color: 'var(--text)', fontSize: '14px', fontWeight: '700' }}>{suggestion.title}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '5px', lineHeight: 1.6 }}>
                      {suggestion.detail}
                    </div>
                  </div>
                  <span style={{
                    padding: '5px 10px',
                    borderRadius: 'var(--radius-pill)',
                    border: `1px solid ${suggestion.priority === 'high' ? 'var(--red)' : suggestion.priority === 'medium' ? 'var(--accent)' : 'var(--navy-border)'}`,
                    background: suggestion.priority === 'high'
                      ? 'var(--danger-bg)'
                      : suggestion.priority === 'medium'
                        ? 'rgba(var(--brand-primary-rgb),0.12)'
                        : 'var(--glass)',
                    color: suggestion.priority === 'high' ? 'var(--red)' : suggestion.priority === 'medium' ? 'var(--accent)' : 'var(--text-muted)',
                    fontSize: '10px',
                    fontWeight: '700',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em'
                  }}>
                    {suggestion.priority}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {Array.isArray(analytics.drawdown_curve) && analytics.drawdown_curve.length > 0 && (
          <Card>
            <SectionHeader
              title={`Trade-by-Trade History (${analytics.drawdown_curve.length} trades)`}
              subtitle="Closed-trade balance progression and drawdown pressure over time."
            />
            <div className="table-wrapper analytics-history-wrapper">
              <table className="data-table analytics-history-table">
                <colgroup>
                  <col style={{ width: '56px' }} />
                  <col style={{ width: '240px' }} />
                  <col style={{ width: '140px' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '220px' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Date</th>
                    <th>Balance</th>
                    <th>P&amp;L</th>
                    <th>Drawdown</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.drawdown_curve.map((point, index) => {
                    const previousBalance = index === 0
                      ? parseFloat(account.starting_balance)
                      : Number(analytics.drawdown_curve[index - 1].balance || 0)
                    const pnl = Number(point.balance || 0) - previousBalance
                    return (
                      <tr key={`curve-point-${index}`}>
                        <td style={{ color: 'var(--text-muted)', textAlign: 'center' }}>{index + 1}</td>
                        <td style={{ color: 'var(--text-muted)', fontSize: '12px' }} className="analytics-history-date">
                          {formatHistoryDate(point.date)}
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontWeight: '600' }}>
                          {formatCurrency(point.balance)}
                        </td>
                        <td style={{ color: pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: '600', fontFamily: 'var(--font-mono)' }}>
                          {formatSignedCurrency(pnl)}
                        </td>
                        <td>
                          <div className="analytics-history-drawdown">
                            <div className="analytics-history-drawdown-bar">
                              <div style={{
                                width: `${Math.min(Number(point.drawdown || 0) * 10, 100)}%`,
                                height: '100%',
                                background: Number(point.drawdown || 0) > 5 ? 'var(--red)' : Number(point.drawdown || 0) > 2 ? 'var(--accent)' : 'var(--green)',
                                transition: 'width 0.3s'
                              }} />
                            </div>
                            <span style={{ fontSize: '11px', color: Number(point.drawdown || 0) > 5 ? 'var(--red)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)', minWidth: '42px', textAlign: 'right' }}>
                              {formatPercent(point.drawdown || 0)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </PageWrapper>
  )
}
