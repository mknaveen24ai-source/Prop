import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js'
import { Bar, Line } from 'react-chartjs-2'
import { PageWrapper } from '../App'
import { useBranding } from '../BrandingContext'
import ThemeToggle from '../components/ThemeToggle'
import { useTheme } from '../ThemeContext'
import './Transparency.css'
import { API_BASE_URL as API_URL } from '../config/apiBase'

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Filler,
  Tooltip,
  Legend
)

const REFRESH_INTERVAL_MS = 60 * 1000 // 60 seconds

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatCurrency(val, compact = false) {
  const n = Number(val) || 0
  if (compact) {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
    if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  }
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatNum(val) {
  return Number(val || 0).toLocaleString('en-US')
}

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function formatDate(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Chart theme resolver ────────────────────────────────────────────────────────
// Reads CSS variable values from the computed style so charts match the theme.
function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function buildChartTheme() {
  return {
    accent:   getCssVar('--accent')    || '#E8B400',
    success:  getCssVar('--success')   || '#4FBE6E',
    muted:    getCssVar('--muted')     || '#8C8880',
    paper:    getCssVar('--paper')     || '#131211',
    rule:     getCssVar('--rule')      || '#3A3733',
    textPrimary:   getCssVar('--text-primary')   || '#EDE9E0',
    textSecondary: getCssVar('--text-secondary') || '#8C8880',
  }
}

function baseChartOptions(theme, yLabel = '') {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        labels: {
          color: theme.textSecondary,
          font: { family: 'IBM Plex Mono, monospace', size: 11 },
          boxWidth: 10,
          padding: 16,
        },
      },
      tooltip: {
        backgroundColor: theme.paper,
        borderColor: theme.rule,
        borderWidth: 1,
        titleColor: theme.textPrimary,
        bodyColor: theme.textSecondary,
        titleFont: { family: 'IBM Plex Mono, monospace', size: 11, weight: 'bold' },
        bodyFont: { family: 'IBM Plex Mono, monospace', size: 11 },
        padding: 12,
      },
    },
    scales: {
      x: {
        ticks: {
          color: theme.textSecondary,
          font: { family: 'IBM Plex Mono, monospace', size: 10 },
          maxTicksLimit: 12,
        },
        grid: { color: theme.rule, lineWidth: 0.5 },
        border: { color: theme.rule },
      },
      y: {
        position: 'left',
        ticks: {
          color: theme.textSecondary,
          font: { family: 'IBM Plex Mono, monospace', size: 10 },
          maxTicksLimit: 6,
          callback: (val) => yLabel === '$' ? formatCurrency(val, true) : val,
        },
        grid: { color: theme.rule, lineWidth: 0.5 },
        border: { color: theme.rule },
      },
    },
  }
}

// ── Sidebar Tab Config ─────────────────────────────────────────────────────────
const TABS = [
  { id: 'overview',    label: 'Overview',    icon: '◈' },
  { id: 'revenue',     label: 'Revenue',     icon: '◉' },
  { id: 'evaluations', label: 'Evaluations', icon: '◎' },
  { id: 'traders',     label: 'Traders',     icon: '◌' },
  { id: 'funded',      label: 'Funded',      icon: '◆' },
  { id: 'payouts',     label: 'Payouts',     icon: '◇' },
  { id: 'activity',    label: 'Activity',    icon: '◉' },
]

// ── Skeleton Loader ────────────────────────────────────────────────────────────
function Skeleton({ height = 32, width = '100%', style = {} }) {
  return (
    <div
      className="tr-skeleton"
      style={{ height, width, minHeight: height, ...style }}
    />
  )
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, valueClass = '' }) {
  return (
    <div className="tr-kpi-card">
      <div className="tr-kpi-label">{label}</div>
      <div className={`tr-kpi-value ${valueClass}`}>{value ?? '—'}</div>
      {sub && <div className={`tr-kpi-sub ${valueClass}`}>{sub}</div>}
    </div>
  )
}

// ── Overview Section ──────────────────────────────────────────────────────────
function OverviewSection({ overview, loading }) {
  const theme = buildChartTheme()
  if (loading) {
    return (
      <div>
        <div className="tr-kpi-grid">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} height={96} />
          ))}
        </div>
      </div>
    )
  }
  const d = overview || {}
  return (
    <div>
      <div className="tr-kpi-grid">
        <KpiCard label="Total Revenue"        value={formatCurrency(d.totalRevenue, true)}     sub={`+${formatCurrency(d.todayRevenue, true)} today`} valueClass="positive" />
        <KpiCard label="Annualized Run Rate"  value={formatCurrency(d.annualizedRunRate, true)} sub="based on last 30d" />
        <KpiCard label="Total Payouts"        value={formatCurrency(d.totalPayouts, true)}      sub="lifetime" valueClass="positive" />
        <KpiCard label="Largest Single Payout" value={formatCurrency(d.largestPayout, true)}   sub="all-time" />
        <KpiCard label="Active Traders"       value={formatNum(d.activeTraders)}                sub="trailing 30 days" />
        <KpiCard label="Funded Traders"       value={formatNum(d.fundedTraders)}                sub="passed a paid evaluation" valueClass="accent" />
        <KpiCard label="Pass Rate"            value={`${d.passRate ?? '—'}%`}                   sub="funded / total traders" />
        <KpiCard label="Funded Trader AUM"    value={formatCurrency(d.aum, true)}               sub="total capital under management" valueClass="positive" />
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }} className="tr-refresh-indicator">
        <span className="tr-refresh-dot" />
        Auto-refreshes every 60 seconds
      </div>
    </div>
  )
}

// ── Revenue Section ───────────────────────────────────────────────────────────
function RevenueSection() {
  const [range, setRange] = useState('30d')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const theme = buildChartTheme()

  useEffect(() => {
    setLoading(true)
    axios.get(`${API_URL}/api/transparency/revenue?range=${range}`)
      .then(res => setData(res.data.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [range])

  const labels = (data || []).map(d => {
    const dt = new Date(d.date)
    return `${dt.getMonth() + 1}/${dt.getDate()}`
  })

  const chartData = {
    labels,
    datasets: [
      {
        type: 'bar',
        label: 'Daily Revenue',
        data: (data || []).map(d => d.daily),
        backgroundColor: `rgba(${getCssVar('--brand-primary-rgb') || '232,180,0'}, 0.35)`,
        borderColor: theme.accent,
        borderWidth: 1,
        yAxisID: 'y',
        order: 2,
      },
      {
        type: 'line',
        label: 'Cumulative',
        data: (data || []).map(d => d.cumulative),
        borderColor: theme.success,
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        yAxisID: 'y2',
        order: 1,
      },
    ],
  }

  const totalRevenue = data?.length ? data[data.length - 1]?.cumulative : null

  return (
    <div>
      <div className="tr-range-pills">
        {['7d', '30d', '90d', 'all'].map(r => (
          <button key={r} className={`tr-pill ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>
            {r.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="tr-chart-card full-width">
        <div className="tr-chart-title">Revenue Over Time</div>
        <div className="tr-chart-subtitle">Daily challenge fees and cumulative revenue</div>
        {totalRevenue != null && (
          <div className="tr-chart-stats">
            <div>
              <div className="tr-chart-stat-val">{formatCurrency(totalRevenue, true)}</div>
              <div className="tr-chart-stat-lbl">Total Revenue ({range})</div>
            </div>
          </div>
        )}
        <div className="tr-chart-wrap">
          {loading ? (
            <Skeleton height={260} />
          ) : (
            <Bar
              data={chartData}
              options={{
                ...baseChartOptions(theme, '$'),
                scales: {
                  ...baseChartOptions(theme, '$').scales,
                  y2: {
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: {
                      color: theme.textSecondary,
                      font: { family: 'IBM Plex Mono, monospace', size: 10 },
                      maxTicksLimit: 6,
                      callback: (val) => formatCurrency(val, true),
                    },
                    border: { color: theme.rule },
                  },
                },
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Evaluations Section ───────────────────────────────────────────────────────
function EvaluationsSection() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const theme = buildChartTheme()

  useEffect(() => {
    axios.get(`${API_URL}/api/transparency/evaluations`)
      .then(res => setData(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="tr-loading">Loading evaluations...</div>

  const { byModel = [], overallPassRate = 0, funnel = {} } = data || {}
  const funnelMax = funnel.total || 1

  const passRateChart = {
    labels: byModel.map(m => m.model),
    datasets: [
      {
        label: 'Pass Rate %',
        data: byModel.map(m => m.passRate),
        backgroundColor: byModel.map(() => `rgba(${getCssVar('--brand-primary-rgb') || '232,180,0'}, 0.4)`),
        borderColor: theme.accent,
        borderWidth: 1,
      },
    ],
  }

  const funnelSteps = [
    { label: 'Started', count: funnel.total },
    { label: 'Phase 1 Pass', count: funnel.phase1Pass },
    { label: 'Phase 2 Pass', count: funnel.phase2Pass },
    { label: 'Funded', count: funnel.funded },
  ]

  return (
    <div>
      {/* Overall pass rate */}
      <div className="tr-kpi-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 24 }}>
        <KpiCard label="Overall Pass Rate" value={`${overallPassRate}%`} sub="funded / total" valueClass="accent" />
        <KpiCard label="Total Funded"      value={formatNum(funnel.funded)} sub="all time" valueClass="positive" />
        <KpiCard label="Evaluations Started" value={formatNum(funnel.total)} sub="unique traders" />
      </div>

      {/* Funnel visualization */}
      <div className="tr-chart-card full-width" style={{ marginBottom: 16 }}>
        <div className="tr-chart-title">Challenge Funnel</div>
        <div className="tr-chart-subtitle">From evaluation start to funded trader</div>
        <div className="tr-funnel" style={{ marginTop: 28 }}>
          {funnelSteps.map((step, idx) => {
            const pct = funnelMax > 0 ? Math.max(8, Math.round((step.count / funnelMax) * 140)) : 8
            const convPct = idx > 0 && funnelSteps[0].count > 0
              ? ((step.count / funnelSteps[0].count) * 100).toFixed(1)
              : null
            return (
              <div key={step.label} className="tr-funnel-step">
                <div className="tr-funnel-bar-wrap">
                  <div className="tr-funnel-bar" style={{ height: pct }} />
                </div>
                <div className="tr-funnel-count">{formatNum(step.count)}</div>
                {convPct && <div className="tr-funnel-pct">{convPct}%</div>}
                <div className="tr-funnel-label">{step.label}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Pass rates by model */}
      {byModel.length > 0 && (
        <div className="tr-chart-card full-width">
          <div className="tr-chart-title">Pass Rate by Challenge Model</div>
          <div className="tr-chart-subtitle">Percentage of traders passing each model type</div>
          <div className="tr-chart-wrap" style={{ height: 220 }}>
            <Bar data={passRateChart} options={baseChartOptions(theme, '%')} />
          </div>
        </div>
      )}

      <div className="tr-models-grid">
        {byModel.map(m => (
          <div key={m.model} className="tr-model-card">
            <div className="tr-model-name">{m.model}</div>
            <div className="tr-model-rate">{m.passRate}%</div>
            <div className="tr-model-meta">{formatNum(m.passed)} passed · {formatNum(m.failed)} failed</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Traders Section ───────────────────────────────────────────────────────────
function TradersSection() {
  const [range, setRange] = useState('30d')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const theme = buildChartTheme()

  useEffect(() => {
    setLoading(true)
    axios.get(`${API_URL}/api/transparency/traders?range=${range}`)
      .then(res => setData(res.data.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [range])

  const labels = (data || []).map(d => {
    const dt = new Date(d.date)
    return `${dt.getMonth() + 1}/${dt.getDate()}`
  })

  const chartData = {
    labels,
    datasets: [
      {
        type: 'bar',
        label: 'Daily New Traders',
        data: (data || []).map(d => d.daily),
        backgroundColor: `rgba(${getCssVar('--brand-primary-rgb') || '232,180,0'}, 0.3)`,
        borderColor: theme.accent,
        borderWidth: 1,
        yAxisID: 'y',
        order: 2,
      },
      {
        type: 'line',
        label: 'Cumulative Traders',
        data: (data || []).map(d => d.cumulative),
        borderColor: theme.success,
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        yAxisID: 'y2',
        order: 1,
      },
    ],
  }

  const latestCumulative = data?.length ? data[data.length - 1]?.cumulative : null
  const totalNew = data?.reduce((s, d) => s + d.daily, 0) ?? null

  return (
    <div>
      <div className="tr-range-pills">
        {['7d', '30d', '90d', 'all'].map(r => (
          <button key={r} className={`tr-pill ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>
            {r.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="tr-chart-card full-width">
        <div className="tr-chart-title">Traders Over Time</div>
        <div className="tr-chart-subtitle">Daily new registrations and cumulative platform trader count</div>
        {(latestCumulative != null || totalNew != null) && (
          <div className="tr-chart-stats">
            {latestCumulative != null && (
              <div>
                <div className="tr-chart-stat-val">{formatNum(latestCumulative)}</div>
                <div className="tr-chart-stat-lbl">Total Traders</div>
              </div>
            )}
            {totalNew != null && (
              <div>
                <div className="tr-chart-stat-val">{formatNum(totalNew)}</div>
                <div className="tr-chart-stat-lbl">New in period</div>
              </div>
            )}
          </div>
        )}
        <div className="tr-chart-wrap">
          {loading ? (
            <Skeleton height={260} />
          ) : (
            <Bar
              data={chartData}
              options={{
                ...baseChartOptions(theme),
                scales: {
                  ...baseChartOptions(theme).scales,
                  y2: {
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: {
                      color: theme.textSecondary,
                      font: { family: 'IBM Plex Mono, monospace', size: 10 },
                      maxTicksLimit: 6,
                    },
                    border: { color: theme.rule },
                  },
                },
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Funded Section ────────────────────────────────────────────────────────────
function FundedSection() {
  const [range, setRange] = useState('30d')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const theme = buildChartTheme()

  useEffect(() => {
    setLoading(true)
    axios.get(`${API_URL}/api/transparency/funded?range=${range}`)
      .then(res => setData(res.data.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [range])

  const labels = (data || []).map(d => {
    const dt = new Date(d.date)
    return `${dt.getMonth() + 1}/${dt.getDate()}`
  })

  const chartData = {
    labels,
    datasets: [
      {
        label: 'Funded Traders',
        data: (data || []).map(d => d.fundedCount),
        borderColor: theme.accent,
        backgroundColor: `rgba(${getCssVar('--brand-primary-rgb') || '232,180,0'}, 0.1)`,
        borderWidth: 2,
        fill: true,
        pointRadius: 0,
        tension: 0.4,
        yAxisID: 'y',
      },
      {
        label: 'Capital AUM ($)',
        data: (data || []).map(d => d.aum),
        borderColor: theme.success,
        backgroundColor: 'rgba(79,190,110,0.08)',
        borderWidth: 2,
        fill: true,
        pointRadius: 0,
        tension: 0.4,
        yAxisID: 'y2',
      },
    ],
  }

  const latestFunded = data?.length ? data[data.length - 1]?.fundedCount : null
  const latestAum    = data?.length ? data[data.length - 1]?.aum : null

  return (
    <div>
      <div className="tr-range-pills">
        {['30d', '90d', '180d', 'all'].map(r => (
          <button key={r} className={`tr-pill ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>
            {r.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="tr-chart-card full-width">
        <div className="tr-chart-title">Funded Traders &amp; Capital</div>
        <div className="tr-chart-subtitle">Number of active funded traders and total capital under management over time</div>
        {(latestFunded != null || latestAum != null) && (
          <div className="tr-chart-stats">
            {latestFunded != null && (
              <div>
                <div className="tr-chart-stat-val">{formatNum(latestFunded)}</div>
                <div className="tr-chart-stat-lbl">Funded Traders</div>
              </div>
            )}
            {latestAum != null && (
              <div>
                <div className="tr-chart-stat-val">{formatCurrency(latestAum, true)}</div>
                <div className="tr-chart-stat-lbl">Total Capital</div>
              </div>
            )}
          </div>
        )}
        <div className="tr-chart-wrap" style={{ height: 300 }}>
          {loading ? (
            <Skeleton height={300} />
          ) : (
            <Line
              data={chartData}
              options={{
                ...baseChartOptions(theme, '$'),
                scales: {
                  ...baseChartOptions(theme).scales,
                  y: {
                    ...baseChartOptions(theme).scales.y,
                    title: {
                      display: true,
                      text: 'Funded Traders',
                      color: theme.textSecondary,
                      font: { family: 'IBM Plex Mono, monospace', size: 10 },
                    },
                  },
                  y2: {
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: {
                      color: theme.textSecondary,
                      font: { family: 'IBM Plex Mono, monospace', size: 10 },
                      maxTicksLimit: 6,
                      callback: (val) => formatCurrency(val, true),
                    },
                    border: { color: theme.rule },
                    title: {
                      display: true,
                      text: 'AUM',
                      color: theme.textSecondary,
                      font: { family: 'IBM Plex Mono, monospace', size: 10 },
                    },
                  },
                },
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Payouts Section ───────────────────────────────────────────────────────────
function PayoutsSection() {
  const [data, setData]   = useState(null)
  const [page, setPage]   = useState(1)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    axios.get(`${API_URL}/api/transparency/payouts?page=${page}`)
      .then(res => setData(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [page])

  if (loading) return <div className="tr-loading">Loading payouts...</div>

  const { payouts = [], total = 0, totalPages = 1 } = data || {}

  return (
    <div>
      <div className="tr-kpi-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 24 }}>
        <KpiCard label="Total Payouts" value={formatNum(total)} sub="paid lifetime" />
        <KpiCard label="Showing" value={`Page ${page} / ${totalPages}`} sub="20 per page" />
      </div>

      <div className="tr-chart-card full-width" style={{ padding: 0 }}>
        <div style={{ padding: '20px 24px 12px', borderBottom: '1px solid var(--rule-soft)' }}>
          <div className="tr-chart-title">Payout History</div>
          <div className="tr-chart-subtitle">All verified payouts — trader identities anonymized</div>
        </div>
        <div className="tr-table-wrap">
          <table className="tr-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Trader</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {payouts.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                    No payouts recorded yet.
                  </td>
                </tr>
              ) : payouts.map((p, idx) => (
                <tr key={idx}>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {(page - 1) * 20 + idx + 1}
                  </td>
                  <td>{p.trader}</td>
                  <td className="amount">{formatCurrency(p.amount)}</td>
                  <td><span className="method-badge">{p.method}</span></td>
                  <td style={{ color: 'var(--text-secondary)' }}>{formatDate(p.date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div style={{ padding: '16px 24px' }}>
            <div className="tr-pagination">
              <button className="tr-page-btn" onClick={() => setPage(p => p - 1)} disabled={page <= 1}>← Prev</button>
              <span className="tr-page-btn current">{page}</span>
              <button className="tr-page-btn" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages}>Next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Activity Section ──────────────────────────────────────────────────────────
function ActivitySection() {
  const [events, setEvents] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchEvents = useCallback(() => {
    axios.get(`${API_URL}/api/transparency/activity`)
      .then(res => setEvents(res.data.events))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchEvents()
    const id = setInterval(fetchEvents, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchEvents])

  // Top performers
  const [performers, setPerformers] = useState(null)
  useEffect(() => {
    axios.get(`${API_URL}/api/transparency/top-performers`)
      .then(res => setPerformers(res.data.performers))
      .catch(() => {})
  }, [])

  if (loading) return <div className="tr-loading">Loading activity feed...</div>

  return (
    <div className="tr-chart-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      {/* Live activity feed */}
      <div className="tr-chart-card">
        <div className="tr-chart-title">Live Activity</div>
        <div className="tr-chart-subtitle">Recent platform events, auto-refreshing</div>
        <div className="tr-activity-feed" style={{ marginTop: 16 }}>
          {(!events || events.length === 0) ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
              No recent activity.
            </div>
          ) : events.map((ev, i) => (
            <div key={i} className="tr-activity-item">
              <div className={`tr-activity-dot ${ev.type}`} />
              <div style={{ flex: 1 }}>
                <div className="tr-activity-label">{ev.label}</div>
                {ev.sublabel && <div className="tr-activity-sub">{ev.sublabel}</div>}
              </div>
              <div className="tr-activity-time">{timeAgo(ev.ts)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Top performers */}
      <div className="tr-chart-card">
        <div className="tr-chart-title">Top Performers</div>
        <div className="tr-chart-subtitle">Leading funded traders by profit percentage</div>
        <div className="tr-performers-list" style={{ marginTop: 16 }}>
          {(!performers || performers.length === 0) ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
              No funded traders yet.
            </div>
          ) : performers.map((p, i) => (
            <div key={i} className="tr-performer-row">
              <div className={`tr-performer-rank ${i === 0 ? 'gold' : ''}`}>#{p.rank}</div>
              <div style={{ flex: 1 }}>
                <div className="tr-performer-name">{p.trader}</div>
                <div className="tr-performer-model">{p.model} · {formatCurrency(p.accountSize, true)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="tr-performer-pct">+{p.profitPct}%</div>
                <div className="tr-performer-usd">+{formatCurrency(p.profitUsd)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main Page Component ───────────────────────────────────────────────────────
export default function Transparency() {
  const [activeTab, setActiveTab] = useState('overview')
  const [overview, setOverview]   = useState(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const { tenant } = useBranding()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)

  // Fetch overview (auto-refreshes every 60s)
  const fetchOverview = useCallback(() => {
    axios.get(`${API_URL}/api/transparency/overview`)
      .then(res => setOverview(res.data))
      .catch(() => {})
      .finally(() => setOverviewLoading(false))
  }, [])

  useEffect(() => {
    fetchOverview()
    const id = setInterval(fetchOverview, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchOverview])

  // Page title & SEO
  useEffect(() => {
    const firmName = tenant?.name || 'PropFirm'
    document.title = `Transparency Dashboard | ${firmName}`
    const prev = document.title
    return () => { document.title = prev }
  }, [tenant])

  // Sticky nav scroll
  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', handler)
    return () => window.removeEventListener('scroll', handler)
  }, [])

  const firmName = String(
    tenant?.logo_text || tenant?.brand?.short_name || tenant?.name || 'PROPFIRM'
  ).toUpperCase()

  function renderSection() {
    switch (activeTab) {
      case 'overview':    return <OverviewSection overview={overview} loading={overviewLoading} />
      case 'revenue':     return <RevenueSection />
      case 'evaluations': return <EvaluationsSection />
      case 'traders':     return <TradersSection />
      case 'funded':      return <FundedSection />
      case 'payouts':     return <PayoutsSection />
      case 'activity':    return <ActivitySection />
      default:            return null
    }
  }

  const sectionTitles = {
    overview:    { title: 'Overview', desc: 'Platform-wide key performance indicators, updated every 60 seconds.' },
    revenue:     { title: 'Revenue',  desc: 'Daily and cumulative platform revenue from challenge fees.' },
    evaluations: { title: 'Evaluations', desc: 'Challenge pass rates by model and phase-by-phase conversion funnel.' },
    traders:     { title: 'Traders', desc: 'Daily new registrations and cumulative trader growth over time.' },
    funded:      { title: 'Funded', desc: 'Active funded accounts and total capital under management over time.' },
    payouts:     { title: 'Payouts', desc: 'Verified payout history — all trader identities are anonymized.' },
    activity:    { title: 'Activity & Top Performers', desc: 'Live feed of recent platform events and leading funded traders.' },
  }

  const current = sectionTitles[activeTab] || {}

  return (
    <PageWrapper>
      <div className="tr-page" data-theme={theme}>

        {/* ── Navbar (reuse Landing nav style) ── */}
        <nav className={`tr-nav${scrolled ? ' scrolled' : ''}`}
          style={{
            boxShadow: scrolled ? '0 1px 0 var(--rule)' : 'none',
            transition: 'box-shadow 0.2s',
          }}
        >
          <Link to="/" className="tr-nav-logo" style={{ textDecoration: 'none' }}>
            {firmName}
          </Link>

          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
            <Link to="/" style={{ color: 'var(--text-secondary)', textDecoration: 'none', fontSize: 13, fontFamily: 'var(--font-ui)' }}
              onMouseOver={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
            >Home</Link>
            <Link to="/leaderboard" style={{ color: 'var(--text-secondary)', textDecoration: 'none', fontSize: 13, fontFamily: 'var(--font-ui)' }}
              onMouseOver={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
            >Leaderboard</Link>
            <span style={{ color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--font-ui)', fontWeight: 600, borderBottom: '1px solid var(--accent)' }}>
              Transparency
            </span>
          </div>

          <div className="tr-nav-actions">
            <ThemeToggle />
            <Link to="/login" className="btn btn-ghost" style={{ textDecoration: 'none', fontSize: 13 }}>Log In</Link>
            <Link to="/register" className="btn btn-primary" style={{ textDecoration: 'none', fontSize: 13 }}>Get Funded</Link>
          </div>
        </nav>

        {/* ── Hero ── */}
        <section className="tr-hero">
          <div className="tr-hero-eyebrow">
            <span className="tr-live-dot" />
            Real-Time · Public Data · No Login Required
          </div>
          <h1>
            Real-Time<br />
            <em>Transparency</em> Dashboard
          </h1>
          <p className="tr-hero-sub">
            Track every metric that matters. From trader performance to
            payouts, evaluations to funded capital — see exactly how{' '}
            {tenant?.name || 'we'} operate in real time.
          </p>
          <div className="tr-hero-badge">
            <span className="tr-live-dot" />
            Live Data
          </div>
        </section>

        {/* ── Body ── */}
        <div className="tr-body">

          {/* Sidebar */}
          <nav className="tr-sidebar" aria-label="Transparency sections">
            <div className="tr-sidebar-label">Sections</div>
            {TABS.map(tab => (
              <button
                key={tab.id}
                id={`tr-tab-${tab.id}`}
                className={`tr-sidebar-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="tr-tab-icon" aria-hidden="true">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <main className="tr-content">
            <div className="tr-section-header">
              <div className="tr-section-title">{current.title}</div>
              <div className="tr-section-desc">{current.desc}</div>
            </div>

            {renderSection()}
          </main>
        </div>

        {/* ── Footer ── */}
        <footer style={{
          borderTop: '1px solid var(--rule)',
          padding: '24px clamp(16px, 3vw, 48px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          background: 'var(--paper)',
        }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
            {firmName} · Transparency Dashboard · All data is public and anonymized
          </div>
          <div style={{ display: 'flex', gap: 24 }}>
            <Link to="/" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Home</Link>
            <Link to="/leaderboard" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Leaderboard</Link>
            <Link to="/register" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Get Funded</Link>
          </div>
        </footer>
      </div>
    </PageWrapper>
  )
}
