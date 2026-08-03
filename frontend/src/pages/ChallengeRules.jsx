import React, { useEffect, useState } from 'react'
import axios from 'axios'
import Card from '../components/ui/Card'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

function formatMoney(value) {
  const amount = parseFloat(value || 0)
  return `$${amount.toFixed(2)}`
}

function formatDateTime(value) {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return '—'
  }
}

function RuleRow({ label, value, accent = false }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '12px 0', borderBottom: '1px solid var(--navy-border)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{label}</span>
      <span style={{ color: accent ? 'var(--accent)' : 'var(--text)', fontSize: '13px', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function ProgressCard({ title, used, remaining, limit, fill, tone = 'var(--accent)' }) {
  return (
    <Card style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', marginBottom: '10px' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      <div style={{ fontSize: '12px', color: fill >= 80 ? 'var(--red)' : tone, fontFamily: 'var(--font-mono)' }}>{fill.toFixed(1)}%</div>
      </div>
      <div style={{ height: '10px', background: 'var(--navy-border)', overflow: 'hidden', marginBottom: '12px' }}>
        <div style={{ height: '100%', width: `${Math.min(fill, 100)}%`, background: fill >= 80 ? 'var(--red)' : tone, transition: 'width 0.4s ease' }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>Used</div>
          <div style={{ fontSize: '13px', color: 'var(--text)' }}>{used}</div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>Remaining</div>
          <div style={{ fontSize: '13px', color: 'var(--text)' }}>{remaining}</div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>Limit</div>
          <div style={{ fontSize: '13px', color: 'var(--text)' }}>{limit}</div>
        </div>
      </div>
    </Card>
  )
}

function PhaseTable({ model, currentStepNumber, isFundedAccount, isCurrentModel }) {
  const stepCount = model.steps || (Array.isArray(model.profit_targets_pct) ? model.profit_targets_pct.length : 1)
  const columns = []
  for (let i = 0; i < stepCount; i++) {
    columns.push({
      key: `step${i + 1}`,
      label: `Step ${i + 1}`,
      isCurrent: isCurrentModel && !isFundedAccount && currentStepNumber === i + 1,
      profitTarget: Array.isArray(model.profit_targets_pct) ? model.profit_targets_pct[i] : model.profit_targets_pct,
      timeLimit: Array.isArray(model.time_limits_days) ? model.time_limits_days[i] : model.time_limits_days,
      consistency: Array.isArray(model.consistency_max_day_pct_by_phase) ? model.consistency_max_day_pct_by_phase[i] : null,
      maxDrawdown: model.max_drawdown_pct,
      dailyDrawdown: model.daily_drawdown_pct,
    })
  }
  columns.push({
    key: 'funded',
    label: 'Funded',
    isCurrent: isCurrentModel && isFundedAccount,
    profitTarget: null,
    timeLimit: null,
    consistency: null,
    maxDrawdown: model.funded_max_drawdown_pct,
    dailyDrawdown: model.funded_daily_drawdown_pct,
    profitSplit: model.profit_split_pct,
  })

  const rows = [
    { label: 'Profit Target', render: (c) => (c.profitTarget > 0 ? `${c.profitTarget}%` : c.key === 'funded' ? '—' : 'No target') },
    { label: 'Max Drawdown', render: (c) => (Number.isFinite(c.maxDrawdown) ? `${c.maxDrawdown}%` : '—') },
    { label: 'Daily Drawdown', render: (c) => (Number.isFinite(c.dailyDrawdown) && c.dailyDrawdown > 0 ? `${c.dailyDrawdown}%` : 'Not set') },
    { label: 'Time Limit', render: (c) => (c.timeLimit ? `${c.timeLimit} days` : c.key === 'funded' ? 'No expiry' : '—') },
    { label: 'Consistency', render: (c) => (Number.isFinite(c.consistency) ? `${c.consistency}%` : '—') },
    { label: 'Profit Split', render: (c) => (c.key === 'funded' && Number.isFinite(c.profitSplit) ? `${c.profitSplit}%` : '—') },
  ]

  return (
    <Card style={{ marginBottom: '20px', border: isCurrentModel ? '1px solid var(--accent)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px', flexWrap: 'wrap' }}>
        <h3 style={{ color: 'var(--accent)', fontSize: '16px', margin: 0 }}>{model.name || 'Phase Table'}</h3>
        {isCurrentModel && <span className="badge badge-success" style={{ fontSize: '10px' }}>Your model</span>}
      </div>
      {model.description && <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '14px' }}>{model.description}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${180 + columns.length * 140}px` }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 12px' }} />
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{
                    textAlign: 'right', padding: '8px 12px', fontSize: '12px',
                    color: c.isCurrent ? 'var(--accent)' : 'var(--text)',
                    borderBottom: `2px solid ${c.isCurrent ? 'var(--accent)' : 'var(--navy-border)'}`,
                  }}
                >
                  {c.label}{c.isCurrent ? ' •' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text-muted)', borderBottom: '1px solid var(--navy-border)' }}>{row.label}</td>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      textAlign: 'right', padding: '10px 12px', fontSize: '13px', fontFamily: 'var(--font-mono)',
                      color: c.isCurrent ? 'var(--accent)' : 'var(--text)',
                      borderBottom: '1px solid var(--navy-border)',
                    }}
                  >
                    {row.render(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export default function ChallengeRules({ selectedAccount, accountRules, stats, openTrades = [], onTradeNow }) {
  // Step 1 / Step 2 / Step 3 / Funded phase table — self-contained fetch off
  // the same public step-models endpoint the challenge purchase flow uses
  // (GetChallenge.jsx). Runs regardless of which account is selected so a
  // competition/no-model account still shows the reference tables.
  const [stepModels, setStepModels] = useState([])
  useEffect(() => {
    let cancelled = false
    axios.get(`${API_URL}/api/accounts/step-models`)
      .then((res) => { if (!cancelled) setStepModels(Array.isArray(res.data?.models) ? res.data.models : []) })
      .catch(() => { if (!cancelled) setStepModels([]) })
    return () => { cancelled = true }
  }, [])

  if (!selectedAccount) {
    return (
      <Card style={{ padding: '48px', textAlign: 'center' }}>
        <h2 className="page-title" style={{ marginBottom: '10px' }}>Challenge Rules</h2>
        <p style={{ color: 'var(--text-muted)' }}>Select an account to see the exact rules for that phase.</p>
      </Card>
    )
  }

  const rules = accountRules?.rules || stats?.rules || null
  const ruleMeta = accountRules?.meta || {}
  const floatingPnl = openTrades
    .filter(trade => trade.status === 'open')
    .reduce((sum, trade) => sum + parseFloat(trade.floating_pnl || 0), 0)
  const liveEquity = stats
    ? parseFloat((parseFloat(stats.account.current_balance || 0) + floatingPnl).toFixed(2))
    : parseFloat(selectedAccount.current_balance || 0)

  const currentModelSlug = accountRules?.account?.challenge_model_slug || selectedAccount.challenge_model_slug || null
  const currentStepNumber = accountRules?.account?.step_number || selectedAccount.step_number || null
  const isFundedAccount = selectedAccount.account_type === 'funded'
  const sortedModels = currentModelSlug
    ? [...stepModels].sort((a, b) => (a.slug === currentModelSlug ? -1 : b.slug === currentModelSlug ? 1 : 0))
    : stepModels

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: '24px' }}>
        <div>
          <h2 className="page-title">Challenge Rules</h2>
          <p style={{ color: 'var(--text-muted)', marginTop: '8px', maxWidth: '760px' }}>
            Everything for this account is listed here in one place so you do not need to guess what applies to your current phase.
          </p>
        </div>
        <button className="btn btn-primary" onClick={onTradeNow} style={{ padding: '10px 18px' }}>
          Open Trading Desk
        </button>
      </div>

      {sortedModels.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <h3 style={{ fontSize: '14px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '12px' }}>
            Step 1 / Step 2 / Step 3 &amp; Funded — Phase Table
          </h3>
          {sortedModels.map((model) => (
            <PhaseTable
              key={model.slug}
              model={model}
              currentStepNumber={currentStepNumber}
              isFundedAccount={isFundedAccount}
              isCurrentModel={model.slug === currentModelSlug}
            />
          ))}
        </div>
      )}

      {!rules ? (
        <Card style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)' }}>Loading account rules...</p>
        </Card>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div className="card-stat">
              <div className="card-stat-title">Account Type</div>
              <div className="card-stat-value" style={{ fontSize: '24px' }}>{selectedAccount.account_type.toUpperCase()}</div>
            </div>
            <div className="card-stat">
              <div className="card-stat-title">Account Size</div>
              <div className="card-stat-value" style={{ fontSize: '24px' }}>${parseFloat(selectedAccount.account_size || 0).toLocaleString('en-US')}</div>
            </div>
            <div className="card-stat">
              <div className="card-stat-title">Live Equity</div>
              <div className="card-stat-value" style={{ fontSize: '24px', color: floatingPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatMoney(liveEquity)}</div>
            </div>
            <div className="card-stat">
              <div className="card-stat-title">Last Trade Activity</div>
              <div className="card-stat-value" style={{ fontSize: '18px' }}>{formatDateTime(ruleMeta.last_trade_at)}</div>
            </div>
          </div>

          {stats && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginBottom: '24px' }}>
              <ProgressCard
                title="Total Drawdown Remaining"
                used={`${parseFloat(stats.stats.total_drawdown_pct || 0).toFixed(2)}%`}
                remaining={`${parseFloat(stats.stats.total_drawdown_remaining_pct || 0).toFixed(2)}%`}
                limit={`${parseFloat(rules.max_drawdown_pct || 0).toFixed(2)}%`}
                fill={parseFloat(stats.stats.total_drawdown_used_pct || 0)}
              />
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
            <Card>
              <h3 style={{ color: 'var(--accent)', marginBottom: '14px', fontSize: '16px' }}>Phase Rules</h3>
              <RuleRow label="Profit Target" value={rules.profit_target_pct > 0 ? `${rules.profit_target_pct.toFixed(2)}% (${formatMoney(rules.profit_target_amount)})` : 'No target'} accent />
              <RuleRow label="Max Drawdown" value={`${parseFloat(rules.max_drawdown_pct || 0).toFixed(2)}%`} />
              <RuleRow label="Time Limit" value={rules.time_limit_days ? `${rules.time_limit_days} days` : 'No expiry'} />
              <RuleRow label="Days Remaining" value={ruleMeta.days_remaining ?? '—'} />
              <RuleRow label="Phase End Date" value={formatDateTime(ruleMeta.phase_end_date)} />
              <RuleRow label="Profit Split" value={`${parseFloat(rules.profit_share_pct || 0).toFixed(0)}%`} />
            </Card>

            <Card>
              <h3 style={{ color: 'var(--accent)', marginBottom: '14px', fontSize: '16px' }}>Trading Restrictions</h3>
              <RuleRow label="Max Daily Trades" value={`${rules.max_daily_trades} per UTC day`} />
              <RuleRow label="Min Hold Time" value={`${rules.min_hold_seconds} seconds`} />
              <RuleRow label="Minimum Lot Size" value={parseFloat(rules.min_lot_size || 0).toFixed(2)} />
              <RuleRow label="Max Open Trades per $1k" value={parseFloat(rules.max_trades_per_1k || 0).toFixed(2)} />
              <RuleRow label="Forex Lots per $1k" value={parseFloat(rules.forex_lots_per_1k || 0).toFixed(2)} />
              <RuleRow label="Commodity Lots per $1k" value={parseFloat(rules.commodity_lots_per_1k || 0).toFixed(2)} />
              <RuleRow label="Weekend Holding" value={rules.weekend_holding_enabled ? 'Allowed' : 'Disabled'} />
            </Card>

            <Card>
              <h3 style={{ color: 'var(--accent)', marginBottom: '14px', fontSize: '16px' }}>Automation & Status</h3>
              <RuleRow label="Status" value={String(selectedAccount.status || '—').toUpperCase()} />
              <RuleRow label="Trades Open Now" value={String(openTrades.filter(trade => trade.status === 'open').length)} />
              <RuleRow label="Pending Orders" value={String(openTrades.filter(trade => trade.status === 'pending').length)} />
              <RuleRow label="Trades Placed Today" value={String(stats?.stats?.trades_today ?? '0')} />
              <RuleRow label="Floating P&L" value={formatMoney(floatingPnl)} />
              <RuleRow label="Inactivity Auto-Fail" value={rules.inactivity_auto_fail_enabled ? `After ${rules.inactivity_fail_days} days` : 'Disabled'} />
              <RuleRow label="Forex Leverage" value={rules.leverage?.forex || '1:30'} />
              <RuleRow label="Commodity Leverage" value={rules.leverage?.commodities || '1:10'} />
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
