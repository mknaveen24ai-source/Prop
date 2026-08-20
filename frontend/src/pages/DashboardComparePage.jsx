import React, { useEffect, useState } from 'react'
import { accountsAPI } from '../services/api'
import Card from '../components/ui/Card'
import ProgressBar from '../components/ui/ProgressBar'
import { renderIcon } from '../utils/iconMap'
import { formatCurrency } from '../utils/finance'
import { getStatusToneColor } from '../utils/statusTone'

/**
 * DashboardComparePage — side-by-side equity/drawdown/P&L comparison across
 * every visible account, for traders running more than one challenge/funded
 * account at once. AccountChipsRow (Home tab) only lets you look at one
 * account at a time; this is the multi-account view the roadmap flagged as
 * missing. Self-fetches per-account stats (GET /api/accounts/stats/:id) in
 * parallel since none of the shared Dashboard.jsx state carries more than
 * the single currently-selected account's stats.
 */
export default function DashboardComparePage({ accounts = [] }) {
  const [statsById, setStatsById] = useState({})
  const [loading, setLoading] = useState(true)
  const [failedIds, setFailedIds] = useState([])

  useEffect(() => {
    if (accounts.length === 0) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    Promise.allSettled(accounts.map((acc) => accountsAPI.getAccountStats(acc.id)))
      .then((results) => {
        if (cancelled) return
        const next = {}
        const failed = []
        results.forEach((res, idx) => {
          const accountId = accounts[idx].id
          if (res.status === 'fulfilled') {
            next[accountId] = res.value.data
          } else {
            failed.push(accountId)
            // Without this the banner only ever said "couldn't load", which is
            // indistinguishable between a 404, a 429 and the server being down.
            console.error('[Compare] stats failed for', accountId, res.reason?.response?.status, res.reason?.response?.data?.error || res.reason?.message)
          }
        })
        setStatsById(next)
        setFailedIds(failed)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.map((a) => a.id).join(',')])

  if (accounts.length === 0) {
    return (
      <Card style={{ textAlign: 'center', padding: 'var(--space-9)', maxWidth: '500px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
          {renderIcon('analytics', { size: 48, color: 'var(--accent)' })}
        </div>
        <h3 style={{ color: 'var(--accent)', marginBottom: 'var(--space-3)' }}>No Accounts Yet</h3>
        <p style={{ color: 'var(--muted)' }}>Start a challenge to see it here.</p>
      </Card>
    )
  }

  if (accounts.length === 1) {
    return (
      <Card style={{ textAlign: 'center', padding: 'var(--space-9)', maxWidth: '500px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
          {renderIcon('analytics', { size: 48, color: 'var(--accent)' })}
        </div>
        <h3 style={{ color: 'var(--accent)', marginBottom: 'var(--space-3)' }}>Only One Account</h3>
        <p style={{ color: 'var(--muted)' }}>Comparison view needs at least 2 accounts — start another challenge to compare performance side by side.</p>
      </Card>
    )
  }

  if (loading) {
    return (
      <Card style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
        <p style={{ color: 'var(--muted)' }}>Loading account comparison…</p>
      </Card>
    )
  }

  const rows = accounts.map((acc) => {
    const detail = statsById[acc.id]
    return {
      account: acc,
      stats: detail?.stats || null,
      failed: failedIds.includes(acc.id),
    }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {failedIds.length > 0 && (
        <div style={{ padding: 'var(--space-3) var(--space-4)', border: '1px solid var(--warn)', borderRadius: 'var(--radius-sm)', color: 'var(--warn)', fontSize: 'var(--fs-base)' }} role="alert">
          Couldn't load stats for {failedIds.length} account{failedIds.length === 1 ? '' : 's'} — the numbers below may be incomplete.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(rows.length, 4)}, minmax(220px, 1fr))`, gap: '14px', overflowX: 'auto' }}>
        {rows.map(({ account, stats, failed }) => (
          <Card key={account.id} ruled eyebrow={`${String(account.account_type || '').toUpperCase()} · ${account.account_uid || account.id}`} title={formatCurrency(account.account_size || 0)}>
            <div style={{ marginBottom: '10px' }}>
              <span className="lx-badge" style={{ color: getStatusToneColor(account.status) }}>{String(account.status || '').toUpperCase()}</span>
            </div>
            {failed || !stats ? (
              <div style={{ color: 'var(--muted)', fontSize: '12.5px', padding: '12px 0' }}>Stats unavailable</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--muted)' }}>Equity</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '19px', marginTop: '3px', color: 'var(--ink)' }}>{formatCurrency(stats.equity || 0)}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)' }}>P&amp;L</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', marginTop: '3px', color: stats.equity_profit_pct >= 0 ? 'var(--gain)' : 'var(--loss)' }}>
                      {stats.equity_profit_pct >= 0 ? '+' : ''}{stats.equity_profit_pct?.toFixed(2)}%
                    </div>
                  </div>
                  <div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)' }}>Today</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', marginTop: '3px', color: stats.today_pnl >= 0 ? 'var(--gain)' : 'var(--loss)' }}>
                      {stats.today_pnl >= 0 ? '+' : ''}{formatCurrency(stats.today_pnl || 0)}
                    </div>
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 'var(--space-1)' }}>
                    <span>Drawdown used</span>
                    <span>{(stats.total_drawdown_used_pct || 0).toFixed(0)}%</span>
                  </div>
                  <ProgressBar
                    value={stats.total_drawdown_used_pct || 0}
                    label="Drawdown used"
                    height={6}
                    trackColor="var(--rule-soft)"
                    color={(stats.total_drawdown_used_pct || 0) >= 80 ? 'var(--loss)' : (stats.total_drawdown_used_pct || 0) >= 50 ? 'var(--warn)' : 'var(--gain)'}
                  />
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}
