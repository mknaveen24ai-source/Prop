import React from 'react'

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
    <div className="card" style={{ padding: '20px' }}>
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
    </div>
  )
}

export default function ChallengeRules({ selectedAccount, accountRules, stats, openTrades = [], onTradeNow }) {
  if (!selectedAccount) {
    return (
      <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
        <h2 className="page-title" style={{ marginBottom: '10px' }}>Challenge Rules</h2>
        <p style={{ color: 'var(--text-muted)' }}>Select an account to see the exact rules for that phase.</p>
      </div>
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

      {!rules ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)' }}>Loading account rules...</p>
        </div>
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
            <div className="card">
              <h3 style={{ color: 'var(--accent)', marginBottom: '14px', fontSize: '16px' }}>Phase Rules</h3>
              <RuleRow label="Profit Target" value={rules.profit_target_pct > 0 ? `${rules.profit_target_pct.toFixed(2)}% (${formatMoney(rules.profit_target_amount)})` : 'No target'} accent />
              <RuleRow label="Max Drawdown" value={`${parseFloat(rules.max_drawdown_pct || 0).toFixed(2)}%`} />
              <RuleRow label="Time Limit" value={rules.time_limit_days ? `${rules.time_limit_days} days` : 'No expiry'} />
              <RuleRow label="Days Remaining" value={ruleMeta.days_remaining ?? '—'} />
              <RuleRow label="Phase End Date" value={formatDateTime(ruleMeta.phase_end_date)} />
              <RuleRow label="Profit Split" value={`${parseFloat(rules.profit_share_pct || 0).toFixed(0)}%`} />
            </div>

            <div className="card">
              <h3 style={{ color: 'var(--accent)', marginBottom: '14px', fontSize: '16px' }}>Trading Restrictions</h3>
              <RuleRow label="Max Daily Trades" value={`${rules.max_daily_trades} per UTC day`} />
              <RuleRow label="Min Hold Time" value={`${rules.min_hold_seconds} seconds`} />
              <RuleRow label="Minimum Lot Size" value={parseFloat(rules.min_lot_size || 0).toFixed(2)} />
              <RuleRow label="Max Open Trades per $1k" value={parseFloat(rules.max_trades_per_1k || 0).toFixed(2)} />
              <RuleRow label="Forex Lots per $1k" value={parseFloat(rules.forex_lots_per_1k || 0).toFixed(2)} />
              <RuleRow label="Commodity Lots per $1k" value={parseFloat(rules.commodity_lots_per_1k || 0).toFixed(2)} />
              <RuleRow label="Weekend Holding" value={rules.weekend_holding_enabled ? 'Allowed' : 'Disabled'} />
            </div>

            <div className="card">
              <h3 style={{ color: 'var(--accent)', marginBottom: '14px', fontSize: '16px' }}>Automation & Status</h3>
              <RuleRow label="Status" value={String(selectedAccount.status || '—').toUpperCase()} />
              <RuleRow label="Trades Open Now" value={String(openTrades.filter(trade => trade.status === 'open').length)} />
              <RuleRow label="Pending Orders" value={String(openTrades.filter(trade => trade.status === 'pending').length)} />
              <RuleRow label="Trades Placed Today" value={String(stats?.stats?.trades_today ?? '0')} />
              <RuleRow label="Floating P&L" value={formatMoney(floatingPnl)} />
              <RuleRow label="Inactivity Auto-Fail" value={rules.inactivity_auto_fail_enabled ? `After ${rules.inactivity_fail_days} days` : 'Disabled'} />
              <RuleRow label="Forex Leverage" value={rules.leverage?.forex || '1:30'} />
              <RuleRow label="Commodity Leverage" value={rules.leverage?.commodities || '1:10'} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
