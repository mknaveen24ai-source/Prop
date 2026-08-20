import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import api from '../services/api'
import { PageWrapper } from '../App'
import Card from '../components/ui/Card'
import ProgressBar from '../components/ui/ProgressBar'
import { SkeletonStats, SkeletonCard, SkeletonTable } from '../components/ui/Skeleton'

// recharts-based — lazy so DashboardHome's own first paint (stat cards,
// header) isn't blocked behind parsing the ~400KB chart chunk, even though
// this screen still needs it immediately (see Suspense fallbacks below).
const Sparkline = lazy(() => import('../components/ui/Sparkline'))
const EquityCurveChart = lazy(() => import('../components/EquityCurveChart'))
import useStore from '../store/useStore'
import { renderIcon } from '../utils/iconMap'
import { filterVisibleTraderAccounts, isTraderAccountVisible } from '../utils/accountVisibility'
import { calculateEquity, formatCurrency, sumMoney } from '../utils/finance'
import { getPersistentItem, setPersistentItem } from '../utils/memoryStore'

function formatMoney(value) {
  return formatCurrency(value)
}
function formatSigned(value) {
  return formatCurrency(value, { signed: true })
}

// Timeframe tab -> equity_curve_ranges key (backend/routes/trades.js buildEquityCurveRanges).
const TF_TABS = [
  { label: '1D', key: 'day' },
  { label: '1W', key: 'week' },
  { label: '1M', key: 'month' },
  { label: 'YTD', key: 'ytd' },
]

// Shared 3-tier scale for drawdown-usage gauges: comfortable well under the
// limit, amber as it's approached, red once it's actually breached-adjacent.
// Both the daily and overall drawdown rows must use this — they previously
// used two different (and inconsistent) binary red/green and amber/red
// scales, which made "overall drawdown at 5% used" read as more alarming
// than "daily drawdown at 74% used".
function getDrawdownTone(usedPct) {
  if (usedPct >= 75) return 'var(--loss)'
  if (usedPct >= 50) return 'var(--warn)'
  return 'var(--gain)'
}

function computeMaxDrawdownPct(curve) {
  if (!Array.isArray(curve) || curve.length === 0) return 0
  let peak = curve[0].value
  let worst = 0
  for (const point of curve) {
    peak = Math.max(peak, point.value)
    if (peak > 0) worst = Math.max(worst, ((peak - point.value) / peak) * 100)
  }
  return worst
}

// ── Account chips + Rules/New Challenge row ─────────────────────────────────
function accountKind(account) {
  if (account.account_type === 'funded') return `Funded · ${String(account.status || 'live').toUpperCase()}`
  const phaseLabel = { phase1: 'Phase 1', phase2: 'Phase 2', phase3: 'Phase 3' }[account.account_type] || account.account_type
  return phaseLabel.toUpperCase()
}

function accountPhaseText(account, isSelected, stats) {
  if (account.account_type === 'funded') {
    const available = stats && isSelected ? Math.max(0, (stats.account.current_balance || 0) - (stats.account.starting_balance || 0)) : null
    return available != null && available >= 50 ? 'Payout eligible' : 'Active'
  }
  if (isSelected && stats?.stats?.days_remaining != null && stats.rules?.time_limit_days) {
    const elapsed = Math.max(0, stats.rules.time_limit_days - stats.stats.days_remaining)
    return `Day ${elapsed} / ${stats.rules.time_limit_days}`
  }
  return String(account.status || 'Active').replace(/^\w/, (c) => c.toUpperCase())
}

function AccountChipsRow({ accounts, selectedAccount, onSelect, stats, onOpenRulesPage, onStartChallenge }) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
      {accounts.map((account) => {
        const isSelected = selectedAccount?.id === account.id
        return (
          <button
            key={account.id}
            onClick={() => onSelect(account)}
            style={{
              textAlign: 'left', padding: '11px 15px', minWidth: '160px',
              border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--rule)'}`,
              borderRadius: 'var(--radius-sm)',
              background: isSelected ? 'var(--soft, color-mix(in srgb, var(--accent) 9%, transparent))' : 'var(--glass)',
              backdropFilter: 'blur(14px)', color: 'var(--ink)',
              boxShadow: isSelected ? 'var(--elev)' : 'none',
              transition: 'border-color .18s, background .18s', cursor: 'pointer',
            }}
          >
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', color: 'var(--muted)', textTransform: 'uppercase' }}>
              {accountKind(account)}
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px', marginTop: '3px' }}>
              ${parseFloat(account.account_size || 0).toLocaleString('en-US')}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--muted)', marginTop: '2px' }}>
              {account.account_uid || account.id} · {accountPhaseText(account, isSelected, stats)}
            </div>
          </button>
        )
      })}
      <div style={{ flex: 1, minWidth: '180px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button
          onClick={onOpenRulesPage}
          className="lx-btn"
          style={{ padding: '9px 16px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--glass)', color: 'var(--ink)' }}
        >
          Rules
        </button>
        <button
          onClick={onStartChallenge}
          className="lx-btn"
          style={{ padding: '9px 16px', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--soft, color-mix(in srgb, var(--accent) 9%, transparent))', color: 'var(--accent)' }}
        >
          New Challenge
        </button>
      </div>
    </div>
  )
}

// ── KPI strip (static — not draggable; only the 4 big blocks below are) ────
function KpiCard({ icon, label, value, delta, sub, tone, sparkData }) {
  return (
    <Card stat tone={tone}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        <span style={{ display: 'inline-flex', color: tone }}>{renderIcon(icon, { size: 13, color: tone })}</span>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 'clamp(20px,1.9vw,26px)', fontWeight: 600, marginTop: '9px', whiteSpace: 'nowrap', letterSpacing: '-.02em' }}>
        {value}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '10px', marginTop: '6px' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: tone }}>
          {delta}<span style={{ color: 'var(--muted)' }}> {sub}</span>
        </div>
        <Suspense fallback={<div style={{ width: 74, height: 26 }} />}>
          <Sparkline data={sparkData} tone={tone} width={74} height={26} />
        </Suspense>
      </div>
    </Card>
  )
}

// ── Consistency donut (small progress ring, Score vs Gap) ──────────────────
function ConsistencyDonut({ score }) {
  const size = 110, strokeWidth = 11
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const safeScore = Math.max(0, Math.min(100, score ?? 0))
  const offset = circumference * (1 - safeScore / 100)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--rule-soft)" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--gain)" strokeWidth={strokeWidth}
        strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dashoffset .6s ease' }}
      />
      <text x="50%" y="47%" textAnchor="middle" dominantBaseline="central" style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 'var(--fs-3xl)', fill: 'var(--gain)' }}>
        {score != null ? Math.round(score) : '—'}
      </text>
      <text x="50%" y="66%" textAnchor="middle" dominantBaseline="central" style={{ fontFamily: 'var(--font-mono)', fontSize: '8px', letterSpacing: '.1em', textTransform: 'uppercase', fill: 'var(--muted)' }}>
        Consistency
      </text>
    </svg>
  )
}

function ConsistencyRiskBlock({ consistency, dailyDrawdown, totalDrawdownUsedPct, totalDrawdownRemainingPct, maxDrawdownPct, profitProgressPct, profitTargetAmount, realizedProfit }) {
  const risks = [
    dailyDrawdown ? {
      label: 'Daily drawdown',
      usedLabel: `${dailyDrawdown.used_pct.toFixed(1)}% used`,
      pct: dailyDrawdown.used_pct,
      tone: getDrawdownTone(dailyDrawdown.used_pct),
      foot: `${formatMoney(dailyDrawdown.amount_used)} of ${formatMoney(dailyDrawdown.limit_amount)} · resets 00:00 UTC`,
    } : {
      // No daily_drawdown_pct configured on this account — show the row
      // honestly as "not configured" rather than silently hiding it (a
      // missing row reads as a bug, not as "no limit").
      label: 'Daily drawdown',
      usedLabel: 'Not configured',
      pct: 0,
      tone: 'var(--muted)',
      foot: 'No daily loss limit set on this account',
    },
    {
      label: 'Overall drawdown',
      usedLabel: `${totalDrawdownUsedPct.toFixed(1)}% used`,
      pct: totalDrawdownUsedPct,
      tone: getDrawdownTone(totalDrawdownUsedPct),
      foot: `${totalDrawdownRemainingPct.toFixed(2)}% remaining of ${maxDrawdownPct.toFixed(2)}% · static`,
    },
    profitTargetAmount > 0 && {
      label: 'Profit target',
      usedLabel: `${profitProgressPct.toFixed(1)}% reached`,
      pct: profitProgressPct,
      tone: 'var(--accent)',
      foot: `${formatMoney(realizedProfit)} of ${formatMoney(profitTargetAmount)}`,
    },
  ].filter(Boolean)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--rule-soft)', paddingBottom: '10px', marginBottom: '14px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px' }}>Consistency</div>
        </div>
        {consistency ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
            <div style={{ width: '110px', flex: '0 0 110px' }}>
              <ConsistencyDonut score={consistency.score} />
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '9px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', fontSize: '12.5px', borderBottom: '1px solid var(--rule-soft)', paddingBottom: '7px' }}>
                <span style={{ color: 'var(--muted)' }}>Best day</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink)' }}>{formatMoney(consistency.best_day_profit)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', fontSize: '12.5px', borderBottom: '1px solid var(--rule-soft)', paddingBottom: '7px' }}>
                <span style={{ color: 'var(--muted)' }}>Share of profit</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--gain)' }}>{consistency.best_day_pct.toFixed(1)}%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', fontSize: '12.5px' }}>
                <span style={{ color: 'var(--muted)' }}>Firm limit</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{consistency.threshold_pct.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-base)', padding: '8px 0' }}>Not enough closed-trade history yet.</div>
        )}
      </Card>

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--rule-soft)', paddingBottom: '10px', marginBottom: '6px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px' }}>Risk Budget</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)' }}>Live</div>
        </div>
        {risks.map((r) => (
          <div key={r.label} style={{ padding: '12px 0', borderBottom: '1px solid var(--rule-soft)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', alignItems: 'baseline' }}>
              <span style={{ fontSize: 'var(--fs-base)' }}>{r.label}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: r.tone }}>{r.usedLabel}</span>
            </div>
            <div style={{ height: '7px', marginTop: '9px', border: '1px solid var(--rule)', borderRadius: '99px', background: 'var(--paper)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, r.pct))}%`, background: r.tone, boxShadow: `0 0 12px ${r.tone}`, transition: 'width .5s cubic-bezier(.16,1,.3,1)' }} />
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--muted)', marginTop: '7px' }}>{r.foot}</div>
          </div>
        ))}
      </Card>
    </div>
  )
}

// ── Open Positions table ────────────────────────────────────────────────────
function OpenPositionsTable({ positions }) {
  const openOnly = positions.filter((t) => t.status === 'open')
  const floatingTotal = openOnly.reduce((sum, t) => sumMoney([sum, t.floating_pnl || 0]), 0)

  return (
    <Card ruled title="Open Positions" actions={(
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>Floating</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', color: floatingTotal >= 0 ? 'var(--gain)' : 'var(--loss)' }}>{formatSigned(floatingTotal)}</span>
      </div>
    )} flush>
      <div className="lx-table-wrap">
        <table className="lx-table">
          <thead>
            <tr>
              <th>Instrument</th><th>Side</th><th>Lots</th><th>Entry</th><th>Market</th><th>Age</th><th>P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {openOnly.length === 0 ? (
              <tr><td colSpan={7} className="lx-table__empty">No open positions</td></tr>
            ) : openOnly.map((t) => {
              const ageMs = Date.now() - new Date(t.open_time).getTime()
              const ageH = Math.floor(ageMs / 3600000)
              const ageM = Math.floor((ageMs % 3600000) / 60000)
              const ageLabel = ageH >= 24 ? `${Math.floor(ageH / 24)}d ${ageH % 24}h` : ageH > 0 ? `${ageH}h ${ageM.toString().padStart(2, '0')}m` : `${ageM}m`
              const pnl = t.floating_pnl || 0
              return (
                <tr key={t.id}>
                  <td>{t.instrument}</td>
                  <td><span className="lx-badge" style={{ color: t.direction === 'buy' ? 'var(--gain)' : 'var(--loss)' }}>{t.direction === 'buy' ? 'BUY' : 'SELL'}</span></td>
                  <td className="lx-num">{parseFloat(t.lot_size).toFixed(2)}</td>
                  <td className="lx-num">{parseFloat(t.open_price).toFixed(t.instrument?.includes('JPY') ? 3 : 5)}</td>
                  <td className="lx-num">{t.current_price != null ? parseFloat(t.current_price).toFixed(t.instrument?.includes('JPY') ? 3 : 5) : '—'}</td>
                  <td className="lx-num">{ageLabel}</td>
                  <td className="lx-num" style={{ color: pnl >= 0 ? 'var(--gain)' : 'var(--loss)' }}>{formatSigned(pnl)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ── Session Heat (dashboard-scoped compact heatmap; never-blank read-out
//    line, matches the Analytics screen's contract — Modern Gazette spec) ──
function SessionHeat({ matrix, hours }) {
  const [hovered, setHovered] = useState(null)
  const maxAbsPnl = matrix.reduce((best, row) => Math.max(best, ...(row.slots || []).map((s) => Math.abs(Number(s.pnl || 0)))), 0) || 1
  const shownHours = hours.filter((h) => h % 6 === 0)

  function cellColor(slot) {
    if (!slot || slot.trades === 0) return 'var(--rule-soft)'
    const intensity = Math.min(1, Math.abs(slot.pnl) / maxAbsPnl)
    const tone = slot.pnl >= 0 ? '79,190,110' : '224,90,90' // --gain / --loss rgb
    return `rgba(${tone},${0.18 + intensity * 0.65})`
  }

  return (
    <div className="ui-scroll-x">
      <div className="heatmap-grid" style={{ marginBottom: 'var(--space-1)' }}>
        <div />
        {hours.map((h) => (
          <div key={h} style={{ fontSize: '8px', textAlign: 'center', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
            {shownHours.includes(h) ? String(h).padStart(2, '0') : ''}
          </div>
        ))}
      </div>
      {matrix.map((row) => (
        <div key={row.day_label} className="heatmap-grid" style={{ marginBottom: '2px', alignItems: 'center' }}>
          <div style={{ fontSize: 'var(--fs-3xs)', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{row.day_label.slice(0, 3).toUpperCase()}</div>
          {(row.slots || []).map((slot) => (
            <div
              key={slot.hour}
              tabIndex={slot.trades > 0 ? 0 : -1}
              onMouseEnter={() => setHovered({ day: row.day_label, ...slot })}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered({ day: row.day_label, ...slot })}
              onBlur={() => setHovered(null)}
              aria-label={slot.trades > 0 ? `${row.day_label} ${String(slot.hour).padStart(2, '0')}:00 — ${slot.trades} trade${slot.trades === 1 ? '' : 's'}, ${formatSigned(slot.pnl || 0)}` : undefined}
              style={{ height: '12px', borderRadius: '1px', background: cellColor(slot), cursor: slot.trades > 0 ? 'pointer' : 'default' }}
            />
          ))}
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: '10px', borderTop: '1px solid var(--rule-soft)', paddingTop: 'var(--space-2)', fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--muted)' }}>
        <span style={{ color: 'var(--loss)' }}>Loss</span>
        <span style={{ flex: '0 0 60px', height: '4px', background: 'linear-gradient(90deg, var(--loss), var(--rule-soft), var(--gain))', borderRadius: '2px' }} />
        <span style={{ color: 'var(--gain)' }}>Gain</span>
        <span style={{ flex: 1 }} />
        <span>
          {hovered
            ? `${hovered.day.slice(0, 3)} ${String(hovered.hour).padStart(2, '0')}:00 · ${hovered.trades} trade${hovered.trades === 1 ? '' : 's'} · ${formatSigned(hovered.pnl || 0)}`
            : 'Select a cell for detail'}
        </span>
      </div>
    </div>
  )
}

// ── Payout cycle banner (funded accounts only) ──────────────────────────────
function PayoutCycleBanner({ payoutCycle, onRequestPayout }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])
  const target = new Date(payoutCycle.next_date).getTime()
  const diff = Math.max(0, target - now)
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  const boxes = [{ v: String(d).padStart(2, '0'), l: 'Days' }, { v: String(h).padStart(2, '0'), l: 'Hours' }, { v: String(m).padStart(2, '0'), l: 'Min' }, { v: String(s).padStart(2, '0'), l: 'Sec' }]

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', flexWrap: 'wrap', background: 'var(--glass-2)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev)', padding: 'var(--space-4) var(--space-5)' }}>
      <div style={{ flex: 1, minWidth: '220px' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--accent)' }}>Next payout window</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '21px', marginTop: 'var(--space-1)' }}>Eligible for a profit share payout</div>
        <div style={{ fontSize: 'var(--fs-base)', color: 'var(--muted)', marginTop: 'var(--space-1)' }}>
          Cycle closes {new Date(payoutCycle.next_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · estimated share {formatMoney(payoutCycle.estimated_share)}
        </div>
      </div>
      {boxes.map((b) => (
        <div key={b.l} style={{ minWidth: '70px', textAlign: 'center', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper)', padding: '10px 12px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xl)', color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>{b.v}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: 'var(--space-1)' }}>{b.l}</div>
        </div>
      ))}
      <button
        onClick={onRequestPayout}
        className="lx-btn"
        style={{ padding: '11px 20px', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--accent)', color: 'var(--paper)', fontSize: '11.5px', letterSpacing: '.12em' }}
      >
        Request Payout
      </button>
    </div>
  )
}

// ── Scaling plan progress (funded accounts on a scaling-enabled model) ─────
// milestones_claimed/progress_pct/total_increased are all computed
// server-side in accounts.js's GET /stats/:id, mirroring the exact milestone
// formula challengeEngine.js's evaluateScalingPlan uses to decide when to
// grant the next real capital increase — see that function's header comment
// for why past increases are excluded from the "trading profit" the
// milestone math is based on.
function ScalingProgressCard({ scaling }) {
  const nextMilestone = scaling.milestones_claimed + 1
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--rule-soft)', paddingBottom: '10px', marginBottom: '14px' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px' }}>Scaling Plan</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--accent)' }}>{scaling.multiplier.toFixed(2)}x lot size</div>
      </div>

      <div style={{ display: 'flex', gap: '18px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>Milestones Claimed</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xl)', marginTop: '3px' }}>{scaling.milestones_claimed}</div>
        </div>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>Capital Added</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xl)', marginTop: '3px', color: 'var(--gain)' }}>{formatMoney(scaling.total_increased)}</div>
        </div>
      </div>

      {scaling.headroom_reached ? (
        <div style={{ fontSize: '12.5px', color: 'var(--muted)' }}>
          Maximum account size reached — no further capital increases, but your lot-size multiplier can still grow.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 'var(--space-1)' }}>
            <span>Progress to milestone {nextMilestone}</span>
            <span>{scaling.progress_pct.toFixed(0)}%</span>
          </div>
          <ProgressBar value={scaling.progress_pct} label={`Progress to scaling milestone ${nextMilestone}`} />
          {scaling.per_milestone_amount > 0 && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--muted)', marginTop: '9px' }}>
              Every {scaling.target_pct}% net trading profit adds {formatMoney(scaling.per_milestone_amount)} to your balance
            </div>
          )}
        </>
      )}
    </Card>
  )
}

export default function DashboardHome({
  user,
  stats,
  openTrades: propOpenTrades = [],
  accounts: propAccounts,
  selectedAccount: propSelectedAccount,
  setSelectedAccount: propSetSelectedAccount,
  onOpenRulesPage,
  onStartChallenge,
  onOpenPayoutsPage,
}) {
  const {
    prices,
    openPositions,
    totalFloatingPnL,
    activeAccount,
    allAccounts,
    setActiveAccount,
    liveEquity: liveEquityMap,
  } = useStore()
  const [nowTick, setNowTick] = useState(Date.now())

  // Draggable block order (Modern Gazette handoff spec: the 4 big widgets —
  // equity chart / consistency+risk / open positions / session heat — are
  // the draggable units, not the small KPI cards). Two independent grid
  // rows, so only equity<->risk and positions<->heat ever swap in practice,
  // but the order map itself is generic (matches the prototype's `ord`).
  const [blockOrder, setBlockOrder] = useState(() => {
    try {
      const saved = JSON.parse(getPersistentItem('dashboard-block-order'))
      if (saved && ['equity', 'risk', 'positions', 'heat'].every((k) => typeof saved[k] === 'number')) return saved
    } catch {}
    return { equity: 1, risk: 2, positions: 3, heat: 4 }
  })
  const dragBlockRef = useRef(null)
  const handleBlockDragStart = (key) => () => { dragBlockRef.current = key }
  const handleBlockDrop = (key) => () => {
    const from = dragBlockRef.current
    dragBlockRef.current = null
    if (!from || from === key) return
    swapBlocks(from, key)
  }
  function swapBlocks(keyA, keyB) {
    setBlockOrder((prev) => {
      const next = { ...prev, [keyA]: prev[keyB], [keyB]: prev[keyA] }
      setPersistentItem('dashboard-block-order', JSON.stringify(next))
      return next
    })
  }
  // Keyboard-accessible equivalent of drag-and-drop reordering: each block
  // only ever swaps with its fixed row partner (equity<->risk,
  // positions<->heat), so a single "Swap position" button per block is a
  // complete, unambiguous alternative to dragging.
  const BLOCK_PARTNERS = { equity: 'risk', risk: 'equity', positions: 'heat', heat: 'positions' }
  const BLOCK_LABELS = { equity: 'Balance & Equity', risk: 'Consistency & Risk', positions: 'Open Positions', heat: 'Session Heat' }
  function SwapBlockButton({ blockKey }) {
    return (
      <button
        type="button"
        onClick={() => swapBlocks(blockKey, BLOCK_PARTNERS[blockKey])}
        aria-label={`Swap position of ${BLOCK_LABELS[blockKey]} with ${BLOCK_LABELS[BLOCK_PARTNERS[blockKey]]}`}
        title="Swap block position"
        style={{
          position: 'absolute', top: '10px', right: '10px', zIndex: 2,
          width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)',
          color: 'var(--muted)', cursor: 'pointer',
        }}
      >
        {renderIcon('repeat', { size: 13 })}
      </button>
    )
  }

  const rawAccounts = allAccounts.length > 0 ? allAccounts : (propAccounts || [])
  const accounts = useMemo(() => filterVisibleTraderAccounts(rawAccounts, nowTick), [rawAccounts, nowTick])
  const selectedAccountCandidate = activeAccount || propSelectedAccount
  const selectedAccount = selectedAccountCandidate && isTraderAccountVisible(selectedAccountCandidate, nowTick)
    ? selectedAccountCandidate
    : accounts[0]
  const openTrades = openPositions.length > 0 ? openPositions : propOpenTrades
  const setSelectedAccount = useCallback((account) => {
    if (!account) return
    setActiveAccount(account)
    if (typeof propSetSelectedAccount === 'function') {
      propSetSelectedAccount(account)
    }
  }, [propSetSelectedAccount, setActiveAccount])

  useEffect(() => {
    if (!selectedAccountCandidate || isTraderAccountVisible(selectedAccountCandidate, nowTick)) return
    setSelectedAccount(accounts[0] || null)
  }, [accounts, nowTick, selectedAccountCandidate, setSelectedAccount])

  useEffect(() => {
    const iv = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  // Single analytics fetch powers the equity curve (all 4 timeframe ranges
  // come back in one response), the Win Rate KPI, and Session Heat — same
  // /api/trades/analytics endpoint the Analytics screen uses.
  const [analytics, setAnalytics] = useState(null)
  const [analyticsError, setAnalyticsError] = useState(false)
  const [tf, setTf] = useState('1M')
  useEffect(() => {
    if (!selectedAccount?.id) { setAnalytics(null); setAnalyticsError(false); return }
    let cancelled = false
    api.get('/api/trades/analytics', { params: { account_id: selectedAccount.id } })
      .then((res) => { if (!cancelled) { setAnalytics(res.data?.analytics || null); setAnalyticsError(false) } })
      .catch(() => { if (!cancelled) setAnalyticsError(true) })
    return () => { cancelled = true }
  }, [selectedAccount?.id])

  const equityCurve = useMemo(() => {
    const rangeKey = TF_TABS.find((t) => t.label === tf)?.key || 'month'
    const ranges = analytics?.equity_curve_ranges || {}
    const raw = (ranges[rangeKey] && ranges[rangeKey].length ? ranges[rangeKey] : ranges.full) || []
    return raw.map((point) => ({
      label: point.date ? new Date(point.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
      value: Number(point.balance || 0),
    }))
  }, [analytics, tf])

  const hasLivePrices = Object.keys(prices || {}).length > 0
  // Equity pushed by the backend engine (ENGINE_MODE=event) is preferred when
  // it's fresh: it is computed server-side against the same prices the engine
  // trades on, so the KPI cards agree with the drawdown the engine is actually
  // enforcing. Under ENGINE_MODE=interval no pushes arrive and this falls back
  // to the locally-derived value, which is also the safety net if the feed
  // stalls. `nowTick` keeps the staleness check re-evaluating.
  const pushedEquity = selectedAccount ? liveEquityMap[selectedAccount.id] : null
  const hasFreshPushedEquity = !!pushedEquity && (nowTick - pushedEquity.received_at) < 5000

  const derivedFloatingPnl = hasLivePrices && openPositions.length > 0
    ? totalFloatingPnL
    : openTrades
      .filter((trade) => trade.status === 'open')
      .map((trade) => trade.floating_pnl || 0)
      .reduce((sum, tradePnl) => sumMoney([sum, tradePnl]), 0)
  const floatingPnl = hasFreshPushedEquity ? pushedEquity.floating_pnl : derivedFloatingPnl
  const liveEquity = hasFreshPushedEquity
    ? pushedEquity.equity
    : (stats ? calculateEquity(stats.account.current_balance || 0, floatingPnl) : 0)
  // Realised balance also moves live — an SL/TP or drawdown close books PnL
  // between refetches, and the push carries the post-close balance.
  const liveBalance = hasFreshPushedEquity
    ? pushedEquity.current_balance
    : (stats?.account.current_balance || 0)
  const isFunded = selectedAccount?.account_type === 'funded'

  if (!stats || !selectedAccount) {
    // "No accounts yet" is a real end state, not a wait — it keeps its message.
    // The loading case gets a skeleton shaped like the dashboard it replaces,
    // so the layout does not collapse and then jump when stats land.
    if (!selectedAccount) {
      return (
        <PageWrapper>
          <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--muted)' }}>
            No accounts yet.
          </div>
        </PageWrapper>
      )
    }
    return (
      <PageWrapper>
        <div role="status" aria-live="polite" aria-busy="true">
          <span className="ui-skeleton-srlabel">Loading account stats</span>
          <SkeletonStats count={4} style={{ marginBottom: 'var(--space-4)' }} />
          <SkeletonCard lines={4} style={{ marginBottom: 'var(--space-4)' }} />
          <SkeletonTable rows={5} columns={5} />
        </div>
      </PageWrapper>
    )
  }

  if (selectedAccount.status === 'locked') {
    return (
      <PageWrapper>
        <Card style={{ textAlign: 'center', padding: 'var(--space-7)' }}>
          <h3 style={{ color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>Account Locked</h3>
          <p style={{ color: 'var(--text-muted)' }}>This account has been locked by admin. Contact support for assistance.</p>
        </Card>
      </PageWrapper>
    )
  }

  const realizedProfit = Math.max(0, liveBalance - (stats.account.starting_balance || 0))
  const kpiSparkData = equityCurve.slice(-14)
  // Nullish-guarded: today_pnl / today_pnl_pct / daily_drawdown / payout_cycle
  // are new fields on GET /accounts/stats — fall back gracefully for a
  // backend that hasn't picked up the change yet rather than crashing.
  const equityProfitPct = stats.stats.equity_profit_pct ?? 0
  const todayPnl = stats.stats.today_pnl ?? 0
  const todayPnlPct = stats.stats.today_pnl_pct ?? 0

  // Drawdown gauges follow the same live-first / fetched-fallback rule as the
  // KPI cards, so the bars move with the feed instead of only on refetch. The
  // fetched `daily_drawdown` object carries the dollar amounts and the limit,
  // which the push doesn't repeat — only the used percentage is overlaid.
  const liveTotalDrawdownUsedPct = hasFreshPushedEquity
    ? Math.max(0, pushedEquity.drawdown_used_pct)
    : (stats.stats.total_drawdown_used_pct ?? 0)
  const liveTotalDrawdownRemainingPct = hasFreshPushedEquity
    ? Math.max(0, (stats.rules?.max_drawdown_pct || 0) - liveTotalDrawdownUsedPct)
    : (stats.stats.total_drawdown_remaining_pct ?? 0)
  const liveDailyDrawdown = hasFreshPushedEquity && stats.stats.daily_drawdown
    ? {
        ...stats.stats.daily_drawdown,
        used_pct: Math.max(0, pushedEquity.daily_drawdown_used_pct ?? stats.stats.daily_drawdown.used_pct)
      }
    : stats.stats.daily_drawdown
  const kpis = [
    {
      key: 'equity', label: 'Equity', icon: 'balance', tone: 'var(--gain)',
      value: formatMoney(liveEquity),
      delta: `${equityProfitPct >= 0 ? '+' : ''}${equityProfitPct.toFixed(2)}%`, sub: 'since start',
    },
    {
      key: 'balance', label: 'Balance', icon: 'wallet', tone: 'var(--accent)',
      value: formatMoney(liveBalance),
      delta: formatSigned(realizedProfit), sub: 'realised',
    },
    {
      key: 'today_pnl', label: "Today's P&L", icon: todayPnl >= 0 ? 'floating_up' : 'floating_down',
      tone: todayPnl >= 0 ? 'var(--gain)' : 'var(--loss)',
      value: formatSigned(todayPnl),
      delta: `${todayPnlPct >= 0 ? '+' : ''}${todayPnlPct.toFixed(2)}%`, sub: 'vs yesterday',
    },
    {
      key: 'win_rate', label: 'Win Rate', icon: 'target', tone: 'var(--accent)',
      value: `${(analytics?.win_rate ?? 0).toFixed(1)}%`,
      delta: `${analytics?.total_trades ?? 0} trades`, sub: 'last 30 days',
    },
  ]

  const activityHeatmap = analytics?.activity_heatmap || { hours: [], matrix: [] }

  const equityBlock = (
    <div
      key="equity" draggable onDragStart={handleBlockDragStart('equity')} onDragOver={(e) => e.preventDefault()} onDrop={handleBlockDrop('equity')}
      role="group" aria-label={BLOCK_LABELS.equity}
      style={{ order: blockOrder.equity, cursor: 'grab', position: 'relative' }}
    >
      <SwapBlockButton blockKey="equity" />
      <Card
        ruled
        eyebrow={`Account ${selectedAccount.account_uid || selectedAccount.id} · equity curve`}
        title="Balance & Equity"
        actions={(
          <div style={{ display: 'flex', gap: '2px', padding: '3px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)' }}>
            {TF_TABS.map((t) => (
              <button
                key={t.label}
                onClick={() => setTf(t.label)}
                style={{
                  padding: '5px 10px', border: 'none', borderRadius: '3px', fontFamily: 'var(--font-mono)', fontSize: '10.5px', letterSpacing: '.06em', cursor: 'pointer',
                  background: tf === t.label ? 'var(--accent)' : 'transparent', color: tf === t.label ? 'var(--paper)' : 'var(--muted)',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      >
        {equityCurve.length > 1 ? (
          <Suspense fallback={<div style={{ height: 250 }} />}>
            <EquityCurveChart data={equityCurve} height={250} />
          </Suspense>
        ) : (
          <div style={{ height: 250, display: 'flex', alignItems: 'center', justifyContent: 'center', color: analyticsError ? 'var(--warn)' : 'var(--muted)', fontSize: 'var(--fs-base)' }}>
            {analyticsError ? "Couldn't load performance data — try refreshing the page." : 'Not enough data for this range yet'}
          </div>
        )}
        {equityCurve.length > 1 && (
          <div style={{ display: 'flex', gap: '22px', borderTop: '1px solid var(--rule-soft)', marginTop: 'var(--space-2)', padding: '11px 2px 6px', flexWrap: 'wrap' }}>
            {[
              { label: 'Opening', value: formatMoney(equityCurve[0].value), tone: 'var(--muted)' },
              { label: 'Current', value: formatMoney(equityCurve[equityCurve.length - 1].value), tone: 'var(--ink)' },
              { label: 'Change', value: formatSigned(equityCurve[equityCurve.length - 1].value - equityCurve[0].value), tone: equityCurve[equityCurve.length - 1].value >= equityCurve[0].value ? 'var(--gain)' : 'var(--loss)' },
              { label: 'Peak', value: formatMoney(Math.max(...equityCurve.map((p) => p.value))), tone: 'var(--accent)' },
              { label: 'Max DD', value: `-${computeMaxDrawdownPct(equityCurve).toFixed(2)}%`, tone: 'var(--loss)' },
            ].map((l) => (
              <div key={l.label}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--muted)' }}>{l.label}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', color: l.tone, marginTop: '3px' }}>{l.value}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )

  const riskBlock = (
    <div
      key="risk" draggable onDragStart={handleBlockDragStart('risk')} onDragOver={(e) => e.preventDefault()} onDrop={handleBlockDrop('risk')}
      role="group" aria-label={BLOCK_LABELS.risk}
      style={{ order: blockOrder.risk, cursor: 'grab', position: 'relative' }}
    >
      <SwapBlockButton blockKey="risk" />
      <ConsistencyRiskBlock
        consistency={stats.stats.consistency}
        dailyDrawdown={liveDailyDrawdown}
        totalDrawdownUsedPct={liveTotalDrawdownUsedPct}
        totalDrawdownRemainingPct={liveTotalDrawdownRemainingPct}
        maxDrawdownPct={stats.rules?.max_drawdown_pct || 0}
        profitProgressPct={stats.rules?.profit_target_amount > 0 ? Math.min(100, (realizedProfit / stats.rules.profit_target_amount) * 100) : 0}
        profitTargetAmount={stats.rules?.profit_target_amount || 0}
        realizedProfit={realizedProfit}
      />
    </div>
  )

  const positionsBlock = (
    <div
      key="positions" draggable onDragStart={handleBlockDragStart('positions')} onDragOver={(e) => e.preventDefault()} onDrop={handleBlockDrop('positions')}
      role="group" aria-label={BLOCK_LABELS.positions}
      style={{ order: blockOrder.positions, cursor: 'grab', position: 'relative' }}
    >
      <SwapBlockButton blockKey="positions" />
      <OpenPositionsTable positions={openTrades} />
    </div>
  )

  const heatBlock = (
    <div
      key="heat" draggable onDragStart={handleBlockDragStart('heat')} onDragOver={(e) => e.preventDefault()} onDrop={handleBlockDrop('heat')}
      role="group" aria-label={BLOCK_LABELS.heat}
      style={{ order: blockOrder.heat, cursor: 'grab', position: 'relative' }}
    >
      <SwapBlockButton blockKey="heat" />
      <Card eyebrow="P&L by day × hour · 30d" title="Session Heat">
        <SessionHeat matrix={activityHeatmap.matrix || []} hours={activityHeatmap.hours || []} />
      </Card>
    </div>
  )

  return (
    <PageWrapper>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <AccountChipsRow
          accounts={accounts}
          selectedAccount={selectedAccount}
          onSelect={setSelectedAccount}
          stats={stats}
          onOpenRulesPage={onOpenRulesPage}
          onStartChallenge={onStartChallenge}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px,1fr))', gap: '14px' }}>
          {/* `key` is destructured out rather than left in the spread: React 19
              errors on a key arriving via {...props}, and it was also being
              forwarded to KpiCard as a normal prop. */}
          {kpis.map(({ key, ...k }) => <KpiCard key={key} {...k} sparkData={kpiSparkData} />)}
        </div>

        <div className="ui-split" style={{ alignItems: 'start', '--split': 'minmax(0,2.1fr) minmax(0,1fr)' }}>
          {equityBlock}
          {riskBlock}
        </div>

        <div className="ui-split" style={{ alignItems: 'start', '--split': 'minmax(0,2.1fr) minmax(0,1fr)' }}>
          {positionsBlock}
          {heatBlock}
        </div>

        {isFunded && stats.stats.payout_cycle && (
          <PayoutCycleBanner payoutCycle={stats.stats.payout_cycle} onRequestPayout={onOpenPayoutsPage} />
        )}

        {isFunded && stats.stats.scaling && (
          <ScalingProgressCard scaling={stats.stats.scaling} />
        )}
      </div>
    </PageWrapper>
  )
}
