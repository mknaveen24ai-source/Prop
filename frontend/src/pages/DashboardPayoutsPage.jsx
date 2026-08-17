import React, { useEffect, useMemo, useState } from 'react'
import api, { accountsAPI } from '../services/api'
import { renderIcon } from '../utils/iconMap'
import Pagination from '../components/Pagination'
import Card from '../components/ui/Card'
import Sparkline from '../components/ui/Sparkline'
import EquityCurveChart from '../components/EquityCurveChart'
import { formatCurrency, calculatePayoutPreview } from '../utils/finance'
import { getStatusToneColor } from '../utils/statusTone'
import { CRYPTO_CURRENCIES, USDT_NETWORKS } from '../utils/paymentMethods'

const PAYOUTS_PAGE_SIZE = 10
const PRESET_PCTS = [0.25, 0.5, 1]
const CURVE_RANGES = [
  { id: 'week', label: '1W' },
  { id: 'month', label: '1M' },
  { id: 'ytd', label: 'YTD' },
  { id: 'full', label: 'Full' },
]

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * DashboardPayoutsPage — Payouts tab (Modern Gazette handoff spec, isPayouts
 * block: KPI strip, "Request a payout" form w/ presets+methods+summary,
 * "Profit split accrual" chart w/ timeframe tabs, Payout history table).
 * Self-fetches the funded account's stats (for the real payout_cycle —
 * cycle_days/next_date/estimated_share, added earlier this pass) and equity
 * curve (for the accrual chart) since Dashboard.jsx's shared `stats` state
 * is scoped to whichever account is selected in the switcher, not
 * necessarily the funded one this screen always operates on.
 */
export default function DashboardPayoutsPage({
  user,
  fundedAccount,
  payouts,
  payoutForm,
  setPayoutForm,
  requestPayout,
  availableProfit,
  profitSharePct,
  API_URL,
}) {
  const [payoutsPage, setPayoutsPage] = useState(1)
  const [payoutCycle, setPayoutCycle] = useState(null)
  const [curveRanges, setCurveRanges] = useState(null)
  const [curveRange, setCurveRange] = useState('month')

  useEffect(() => {
    if (!fundedAccount?.id) return
    accountsAPI.getAccountStats(fundedAccount.id)
      .then((res) => setPayoutCycle(res.data?.stats?.payout_cycle || null))
      .catch(() => setPayoutCycle(null))
    api.get('/api/trades/analytics', { params: { account_id: fundedAccount.id } })
      .then((res) => setCurveRanges(res.data?.analytics?.equity_curve_ranges || null))
      .catch(() => setCurveRanges(null))
  }, [fundedAccount?.id, API_URL])

  const accrualData = useMemo(() => {
    const points = curveRanges?.[curveRange]
    if (!Array.isArray(points) || points.length === 0) return []
    const starting = fundedAccount?.starting_balance || points[0]?.balance || 0
    return points.map((p) => ({
      label: formatDate(p.date),
      value: parseFloat((Math.max(0, (p.balance || 0) - starting) * (profitSharePct / 100)).toFixed(2)),
    }))
  }, [curveRanges, curveRange, fundedAccount, profitSharePct])

  const lifetimePaid = useMemo(
    () => payouts.filter((p) => p.status === 'paid').reduce((sum, p) => sum + parseFloat(p.amount_payable || 0), 0),
    [payouts]
  )
  const paidSpark = useMemo(() => {
    const paid = [...payouts].filter((p) => p.status === 'paid' && p.paid_at).sort((a, b) => new Date(a.paid_at) - new Date(b.paid_at))
    let running = 0
    return paid.map((p) => { running += parseFloat(p.amount_payable || 0); return { value: running } })
  }, [payouts])

  if (!fundedAccount) {
    return (
      <div>
        <Card style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('payouts', { size: 48, color: 'var(--accent)' })}
          </div>
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Funded Account Yet</h3>
          <p style={{ color: 'var(--muted)' }}>Complete Phase 1 and Phase 2 to unlock payouts.</p>
        </Card>
      </div>
    )
  }

  const totalPayoutPages = Math.ceil(payouts.length / PAYOUTS_PAGE_SIZE)
  const pagedPayouts = payouts.slice((payoutsPage - 1) * PAYOUTS_PAGE_SIZE, payoutsPage * PAYOUTS_PAGE_SIZE)

  const kpis = [
    { label: 'Available Balance', value: formatCurrency(availableProfit), sub: 'Realized profit', tone: 'var(--gain)', spark: (curveRanges?.month || []).map((p) => ({ value: p.balance })) },
    { label: 'Your Share', value: `${profitSharePct}%`, sub: 'Of realized profit', tone: 'var(--accent)', spark: [] },
    { label: 'Next Payout Window', value: payoutCycle ? formatDate(payoutCycle.next_date) : '—', sub: payoutCycle ? `${payoutCycle.cycle_days}-day cycle` : 'Not funded yet', tone: 'var(--warn)', spark: [] },
    { label: 'Lifetime Paid Out', value: formatCurrency(lifetimePaid), sub: `${payouts.filter((p) => p.status === 'paid').length} payouts`, tone: 'var(--gain)', spark: paidSpark },
  ]

  const presetAmount = (pct) => Math.floor(availableProfit * pct * 100) / 100

  const [payoutCurrency, payoutNetwork] = payoutForm.payment_method.startsWith('usdt_')
    ? ['usdt', payoutForm.payment_method.slice(5)]
    : [payoutForm.payment_method, USDT_NETWORKS[0].id]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px,1fr))', gap: '14px' }}>
        {kpis.map((k) => (
          <Card key={k.label} stat tone={k.tone}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>{k.label}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'clamp(20px,1.8vw,25px)', whiteSpace: 'nowrap', marginTop: '8px', color: k.tone }}>{k.value}</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '10px', marginTop: '6px' }}>
              <span style={{ fontSize: '11.5px', color: 'var(--muted)' }}>{k.sub}</span>
              {k.spark.length > 1 && <Sparkline data={k.spark} tone={k.tone} width={70} height={24} />}
            </div>
          </Card>
        ))}
      </div>

      <div className="ui-split" style={{ alignItems: 'start', '--split': 'minmax(0,1fr) minmax(0,1.5fr)' }}>
        {/* Request a payout */}
        <form onSubmit={requestPayout} style={{ background: 'var(--glass-2)', backdropFilter: 'blur(18px)', border: '1px solid var(--accent)', borderRadius: '4px', boxShadow: 'var(--elev)', padding: '18px 20px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '20px', borderBottom: '3px double var(--rule)', paddingBottom: '12px', marginBottom: '16px' }}>Request a payout</div>

          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: '6px' }}>
            Amount available — {formatCurrency(availableProfit)}
          </div>
          <input
            type="number"
            value={payoutForm.amount_requested}
            onChange={(e) => setPayoutForm({ ...payoutForm, amount_requested: e.target.value })}
            placeholder={`Max ${formatCurrency(availableProfit)}`}
            min="50"
            max={availableProfit}
            step="0.01"
            style={{ width: '100%', padding: '12px 14px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'var(--paper)', color: 'var(--ink)', fontFamily: 'var(--font-mono)', fontSize: '19px' }}
          />
          <div style={{ display: 'flex', gap: '6px', marginTop: '9px' }}>
            {PRESET_PCTS.map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => setPayoutForm({ ...payoutForm, amount_requested: String(presetAmount(pct)) })}
                style={{ flex: 1, padding: '8px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'transparent', color: 'var(--ink)', fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '.08em', textTransform: 'uppercase', cursor: 'pointer' }}
              >
                {pct === 1 ? 'Max' : `${pct * 100}%`}
              </button>
            ))}
          </div>

          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)', margin: '16px 0 8px' }}>Cryptocurrency</div>
          {CRYPTO_CURRENCIES.map((m) => {
            const active = payoutCurrency === m.id
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setPayoutForm({ ...payoutForm, payment_method: m.id === 'usdt' ? `usdt_${payoutNetwork}` : m.id })}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '10px 12px', marginBottom: '6px',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--rule)'}`, borderRadius: '4px',
                  background: active ? 'var(--glass)' : 'transparent', cursor: 'pointer', textAlign: 'left'
                }}
              >
                <span style={{ width: '8px', height: '8px', background: m.tone, flex: '0 0 auto' }} />
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: '13px', color: 'var(--ink)' }}>{m.label}</span>
                  <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--muted)', marginTop: '2px' }}>{m.meta}</span>
                </span>
              </button>
            )
          })}

          {payoutCurrency === 'usdt' && (
            <>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)', margin: '12px 0 8px' }}>Network</div>
              {USDT_NETWORKS.map((n) => {
                const active = payoutNetwork === n.id
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => setPayoutForm({ ...payoutForm, payment_method: `usdt_${n.id}` })}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '10px 12px', marginBottom: '6px',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--rule)'}`, borderRadius: '4px',
                      background: active ? 'var(--glass)' : 'transparent', cursor: 'pointer', textAlign: 'left'
                    }}
                  >
                    <span style={{ width: '8px', height: '8px', background: n.tone, flex: '0 0 auto' }} />
                    <span style={{ flex: 1 }}>
                      <span style={{ display: 'block', fontSize: '13px', color: 'var(--ink)' }}>{n.label}</span>
                      <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--muted)', marginTop: '2px' }}>{n.meta}</span>
                    </span>
                  </button>
                )
              })}
            </>
          )}

          <div>
            <label style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Payment Details</label>
            <textarea
              value={payoutForm.payment_details}
              onChange={(e) => setPayoutForm({ ...payoutForm, payment_details: e.target.value })}
              placeholder="Enter your wallet address"
              rows="3"
              required
              style={{ width: '100%', marginTop: '6px', resize: 'vertical' }}
            />
            <p style={{ marginTop: '8px', fontSize: '11px', color: 'var(--warn)' }}>
              Double-check before submitting — crypto payouts are final. Funds sent to an incorrect address or wrong network cannot be recovered.
            </p>
          </div>

          <div style={{ borderTop: '1px solid var(--rule-soft)', marginTop: '14px', paddingTop: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '5px 0', fontSize: '12.5px' }}>
              <span style={{ color: 'var(--muted)' }}>Requested amount</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{formatCurrency(payoutForm.amount_requested || 0)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '5px 0', fontSize: '12.5px' }}>
              <span style={{ color: 'var(--muted)' }}>Your share</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{profitSharePct}%</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '5px 0', fontSize: '12.5px' }}>
              <span style={{ color: 'var(--muted)' }}>You receive</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--gain)' }}>{formatCurrency(calculatePayoutPreview(payoutForm.amount_requested || 0, profitSharePct))}</span>
            </div>
          </div>

          <button
            type="submit"
            disabled={availableProfit < 50}
            style={{ width: '100%', marginTop: '16px', padding: '13px', border: '1px solid var(--accent)', borderRadius: '4px', background: availableProfit < 50 ? 'var(--rule)' : 'var(--accent)', color: 'var(--paper)', fontFamily: 'var(--font-mono)', fontSize: '11.5px', letterSpacing: '.12em', textTransform: 'uppercase', cursor: availableProfit < 50 ? 'not-allowed' : 'pointer' }}
          >
            {availableProfit < 50 ? 'Minimum $50 required' : 'Submit request'}
          </button>
        </form>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Profit split accrual */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', borderBottom: '1px solid var(--rule-soft)', paddingBottom: '12px', marginBottom: '14px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '19px' }}>Profit split accrual</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: '3px' }}>
                  {payoutCycle ? `Cycle ends ${formatDate(payoutCycle.next_date)}` : 'Cycle'} · your {profitSharePct}% share
                </div>
              </div>
              <div style={{ display: 'flex', gap: '2px', padding: '3px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'var(--paper-2)' }}>
                {CURVE_RANGES.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setCurveRange(r.id)}
                    style={{
                      padding: '5px 10px', border: 'none', borderRadius: '3px', cursor: 'pointer',
                      background: curveRange === r.id ? 'var(--accent)' : 'transparent',
                      color: curveRange === r.id ? 'var(--paper)' : 'var(--muted)',
                      fontFamily: 'var(--font-mono)', fontSize: '10.5px', letterSpacing: '.06em'
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            {accrualData.length > 1 ? (
              <EquityCurveChart data={accrualData} height={200} tone="var(--gain)" />
            ) : (
              <div style={{ textAlign: 'center', padding: '48px', color: 'var(--muted)', fontSize: '13px' }}>Not enough trading history yet for this range.</div>
            )}
          </Card>

          {/* Payout history */}
          <Card ruled flush title="Payout history" actions={payouts.some((p) => p.status === 'paid') && (
            <button
              onClick={() => { const link = document.createElement('a'); link.href = `${API_URL}/api/payouts/statement`; link.target = '_blank'; link.click() }}
              className="lx-btn"
              style={{ padding: '8px 12px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)' }}
              title="Download your payout statement as HTML (printable / save as PDF)"
            >
              Download Statement
            </button>
          )}>
            {payouts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px', color: 'var(--muted)' }}>No payouts requested yet.</div>
            ) : (
              <>
                <div className="lx-table-wrap">
                <table className="lx-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Amount</th>
                      <th>You Receive</th>
                      <th>Method</th>
                      <th>Status</th>
                      <th>Requested</th>
                      <th>Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedPayouts.map((p) => (
                      <tr key={p.id}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{p.account_uid || p.account_id || '—'}</td>
                        <td style={{ fontFamily: 'var(--font-mono)' }}>{formatCurrency(p.amount_requested)}</td>
                        <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--gain)' }}>{formatCurrency(p.amount_payable)}</td>
                        <td>{p.payment_method}</td>
                        <td><span className="lx-badge" style={{ color: getStatusToneColor(p.status) }}>{p.status}</span></td>
                        <td style={{ color: 'var(--muted)' }}>{formatDate(p.requested_at)}</td>
                        <td style={{ color: 'var(--muted)' }}>{p.paid_at ? formatDate(p.paid_at) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                <div style={{ padding: '10px 18px' }}>
                  <Pagination page={payoutsPage} totalPages={totalPayoutPages} onPageChange={setPayoutsPage} pageSize={PAYOUTS_PAGE_SIZE} total={payouts.length} />
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
