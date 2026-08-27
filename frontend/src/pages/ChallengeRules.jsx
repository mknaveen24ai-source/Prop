import React, { useEffect, useState } from 'react'
import axios from 'axios'
import Card from '../components/ui/Card'
import { renderIcon } from '../utils/iconMap'
import { API_BASE_URL as API_URL } from '../config/apiBase'


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
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: 'var(--space-3) 0', borderBottom: '1px solid var(--navy-border)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)' }}>{label}</span>
      <span style={{ color: accent ? 'var(--accent)' : 'var(--text)', fontSize: 'var(--fs-base)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

// ── "What ends the account" / "What is expressly allowed" ─────────────────
// Deliberately conservative — every item here maps to an actual enforcement
// path already confirmed in the backend (drawdownService.js, trades.js's
// breach-monitor job, tenant settings), not the prototype's placeholder
// copy verbatim. No "latency arbitrage" / "copy trading" / "one free
// reset" claims — none of that is actually enforced or offered by this
// platform today, and this page shouldn't promise rules that don't exist.
export function buildRuleColumns(rules, { isFundedAccount, currentModel, currentStepNumber } = {}) {
  const allowedItems = [
    // Overnight and weekend are TWO rules with two different enforcers, and
    // showing them as one told traders the wrong thing. weekendCloseService
    // reads the platform setting weekend_holding_enabled; flatByCloseService
    // reads challenge_models.allow_overnight, which the three seeded models set
    // to FALSE. A trader reading a single "permitted" line was being force-closed
    // daily by a rule the page never mentioned. Each card now renders the value
    // its own enforcer actually reads.
    {
      title: 'Holding over the weekend',
      body: rules.weekend_holding_enabled
        ? 'Permitted — positions may be held through the weekend close. This applies platform-wide, evaluation and funded accounts alike.'
        : 'Not permitted — open positions are force-closed and pending orders cancelled before the weekend, on every account, evaluation and funded alike.',
      tone: rules.weekend_holding_enabled ? 'var(--gain)' : 'var(--warn)', icon: rules.weekend_holding_enabled ? 'approve' : 'warning',
    },
    {
      title: 'Holding overnight',
      body: currentModel && currentModel.allow_overnight === false
        ? 'Not permitted on this model — open positions are flattened at the daily close. Size and time your trades so nothing needs to survive the session end.'
        : 'Permitted — positions may be carried through the daily close.',
      tone: (currentModel && currentModel.allow_overnight === false) ? 'var(--warn)' : 'var(--gain)',
      icon: (currentModel && currentModel.allow_overnight === false) ? 'warning' : 'approve',
    },
    {
      title: 'Any hold time above the minimum',
      body: `No maximum hold time — hold a position for as long as you like. See "How the minimum hold window works" for the one thing it does affect.`,
      tone: 'var(--gain)', icon: 'approve',
    },
    {
      title: 'Unlimited leverage, no position-size cap',
      body: `There is no margin requirement and no limit on how large a position can be relative to your account. Minimum lot size is ${parseFloat(rules.min_lot_size || 0).toFixed(2)}, and you may hold up to ${rules.max_open_positions || 10} positions at once. Your risk is governed by the drawdown rules on the left, not by position size — size accordingly.`,
      tone: 'var(--gain)', icon: 'approve',
    },
  ]
  if (isFundedAccount && currentModel?.funded_drawdown_locks_at_pct != null) {
    allowedItems.push({
      title: 'Your drawdown floor locks in your favor',
      body: `Once equity reaches ${currentModel.funded_drawdown_locks_at_pct}% above starting balance, your drawdown floor locks at that level for good — it won't drop back below it even if equity pulls back later.`,
      tone: 'var(--gain)', icon: 'approve',
    })
  }

  const columns = [
    {
      title: 'What ends the account',
      items: [
        {
          title: 'Daily loss cap breached',
          body: `Measured on today's realized + floating P&L against your starting balance. ${rules.daily_drawdown_pct > 0 ? `Currently ${rules.daily_drawdown_pct}% of starting balance.` : 'No daily limit configured on this account.'} Resets 00:00 UTC.`,
          tone: 'var(--loss)', icon: 'warning',
        },
        {
          title: 'Overall drawdown breached',
          body: `A trailing floor from your peak equity — it only ever rises as you profit, never drops. Currently ${rules.max_drawdown_pct}% of peak equity.`,
          tone: 'var(--loss)', icon: 'warning',
        },
        {
          title: 'Inactivity',
          body: rules.inactivity_auto_fail_enabled
            ? `No trades placed for ${rules.inactivity_fail_days} consecutive days auto-fails the account.`
            : 'Inactivity auto-fail is currently disabled on this account.',
          tone: 'var(--loss)', icon: 'timer',
        },
      ],
    },
    {
      title: 'What is expressly allowed',
      items: allowedItems,
    },
    {
      title: 'Execution you should know about',
      items: [
        {
          title: 'How the minimum hold window works',
          body: `Every position must stay open for at least ${rules.min_hold_seconds} seconds — you cannot close one by hand before then. Your stop loss and take profit still protect you throughout: if price crosses your level inside the window, we record the crossing and fill you at your level the moment the window ends, even if price has moved back the other way since. You get the level you set, not the price ${rules.min_hold_seconds} seconds later.`,
          tone: 'var(--accent)', icon: 'timer',
        },
        {
          title: 'Slippage is simulated, and it is symmetric',
          body: 'Fills carry a small random slippage drawn evenly from either side of the quoted price, so it moves in your favour as often as it moves against you. It is never biased towards the house. Execution is simulated against live institutional pricing — no order is routed to an external venue.',
          tone: 'var(--accent)', icon: 'repeat',
        },
        {
          title: 'No swap or overnight financing',
          body: 'Positions carry no financing cost. Holding overnight or over a weekend costs you nothing beyond spread and commission — there is no swap charge on this platform, in either direction.',
          tone: 'var(--accent)', icon: 'moon',
        },
      ],
    },
  ]

  if (currentModel) {
    const requirementItems = []
    if (isFundedAccount) {
      if (currentModel.funded_min_trading_days_for_payout != null) {
        requirementItems.push({
          title: 'Minimum trading days',
          body: `${currentModel.funded_min_trading_days_for_payout} qualifying days needed before your first payout — a day counts once you're up ${currentModel.min_daily_profit_pct}% of starting balance that day.`,
          tone: 'var(--accent)', icon: 'target',
        })
      }
      if (currentModel.funded_payout_min_net_profit_pct != null) {
        requirementItems.push({
          title: 'Minimum net profit',
          body: `${currentModel.funded_payout_min_net_profit_pct}% net profit required on the account before your first payout request. No further lock-up after that.`,
          tone: 'var(--accent)', icon: 'target',
        })
      }
      if (currentModel.funded_consistency_max_day_pct != null) {
        requirementItems.push({
          title: 'Consistency rule',
          body: `No single day's profit can exceed ${currentModel.funded_consistency_max_day_pct}% of your total profit when you request a payout. If it does, it's a soft hold, not a fail — keep trading to bring the ratio down.`,
          tone: 'var(--accent)', icon: 'info',
        })
      }
      if (currentModel.scaling_target_pct != null && currentModel.scaling_multiplier != null) {
        requirementItems.push({
          title: 'Scaling plan',
          body: `Every ${currentModel.scaling_target_pct}% net-profit milestone doubles (${currentModel.scaling_multiplier}x) your risk-capacity multiplier, compounding with every milestone you hit${currentModel.scaling_max_account_size ? ` — capped so your effective size never exceeds $${currentModel.scaling_max_account_size.toLocaleString('en-US')}.` : '.'}`,
          tone: 'var(--accent)', icon: 'info',
        })
      }
    } else {
      const phaseIdx0 = Math.max(0, (currentStepNumber || 1) - 1)
      const consistencyPct = Array.isArray(currentModel.consistency_max_day_pct_by_phase)
        ? currentModel.consistency_max_day_pct_by_phase[phaseIdx0]
        : null
      if (currentModel.min_trading_days != null) {
        requirementItems.push({
          title: 'Minimum trading days',
          body: `${currentModel.min_trading_days} qualifying days needed to pass this phase — a day counts once you're up ${currentModel.min_daily_profit_pct}% of starting balance that day. Hitting the profit target early doesn't skip this.`,
          tone: 'var(--accent)', icon: 'target',
        })
      }
      if (consistencyPct != null) {
        requirementItems.push({
          title: 'Consistency rule',
          body: `No single day's profit can exceed ${consistencyPct}% of your total profit when you hit the target. If it does, it's a soft hold, not a fail — keep trading to bring the ratio down and you'll pass automatically.`,
          tone: 'var(--accent)', icon: 'info',
        })
      }
    }
    if (requirementItems.length > 0) {
      columns.push({
        title: isFundedAccount ? 'Payout eligibility' : "What's required to pass",
        items: requirementItems,
      })
    }
  }

  return columns
}

export function PhaseTable({ model, currentStepNumber, isFundedAccount, isCurrentModel }) {
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
      minTradingDays: model.min_trading_days,
    })
  }
  columns.push({
    key: 'funded',
    label: 'Funded',
    isCurrent: isCurrentModel && isFundedAccount,
    profitTarget: null,
    timeLimit: null,
    consistency: model.funded_consistency_max_day_pct != null ? model.funded_consistency_max_day_pct : null,
    maxDrawdown: model.funded_max_drawdown_pct,
    dailyDrawdown: model.funded_daily_drawdown_pct,
    profitSplit: model.profit_split_pct,
    minTradingDays: model.funded_min_trading_days_for_payout,
  })

  const rows = [
    { label: 'Profit Target', render: (c) => (c.profitTarget > 0 ? `${c.profitTarget}%` : c.key === 'funded' ? '—' : 'No target') },
    { label: 'Max Drawdown', render: (c) => (Number.isFinite(c.maxDrawdown) ? `${c.maxDrawdown}%` : '—') },
    { label: 'Daily Drawdown', render: (c) => (Number.isFinite(c.dailyDrawdown) && c.dailyDrawdown > 0 ? `${c.dailyDrawdown}%` : 'Not set') },
    { label: 'Time Limit', render: (c) => (c.timeLimit ? `${c.timeLimit} days` : c.key === 'funded' ? 'No expiry' : '—') },
    { label: 'Min. Trading Days', render: (c) => (Number.isFinite(c.minTradingDays) ? `${c.minTradingDays} days` : '—') },
    { label: 'Consistency', render: (c) => (Number.isFinite(c.consistency) ? `${c.consistency}%` : '—') },
    { label: 'Profit Split', render: (c) => (c.key === 'funded' && Number.isFinite(c.profitSplit) ? `${c.profitSplit}%` : '—') },
  ]

  return (
    <Card style={{ marginBottom: 'var(--space-4)', border: isCurrentModel ? '1px solid var(--accent)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2-5)', marginBottom: 'var(--space-1)', flexWrap: 'wrap' }}>
        <h3 style={{ color: 'var(--accent)', fontSize: 'var(--fs-lg)', margin: 0 }}>{model.name || 'Phase Table'}</h3>
        {isCurrentModel && <span className="badge badge-success" style={{ fontSize: 'var(--fs-2xs)' }}>Your model</span>}
      </div>
      {model.description && <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--space-3-5)' }}>{model.description}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${180 + columns.length * 140}px` }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 'var(--space-2) var(--space-3)' }} />
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{
                    textAlign: 'right', padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--fs-sm)',
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
                <td style={{ padding: 'var(--space-2-5) var(--space-3)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', borderBottom: '1px solid var(--navy-border)' }}>{row.label}</td>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      textAlign: 'right', padding: 'var(--space-2-5) var(--space-3)', fontSize: 'var(--fs-base)', fontFamily: 'var(--font-mono)',
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
      <Card style={{ padding: 'var(--space-9)', textAlign: 'center' }}>
        <h2 className="page-title" style={{ marginBottom: 'var(--space-2-5)' }}>The Rulebook, in full</h2>
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

  const phaseLabel = isFundedAccount
    ? 'Funded'
    : selectedAccount.account_type === 'competition'
      ? 'Competition'
      : `Phase ${currentStepNumber || 1}`
  const kicker = `$${parseFloat(selectedAccount.account_size || 0).toLocaleString('en-US')} · Account ${selectedAccount.account_uid || selectedAccount.id} · ${phaseLabel}`

  const currentModel = currentModelSlug ? stepModels.find((m) => m.slug === currentModelSlug) || null : null
  // Funded accounts gate the payout on funded_min_trading_days_for_payout;
  // evaluation phases gate the pass on min_trading_days. Same rule, two fields.
  const minDaysForStage = parseInt(
    (isFundedAccount ? currentModel?.funded_min_trading_days_for_payout : currentModel?.min_trading_days) || 0,
    10
  )
  const ruleLimits = rules ? [
    { label: 'Profit target', value: rules.profit_target_amount > 0 ? formatMoney(rules.profit_target_amount) : 'No target', tone: 'var(--accent)', note: rules.profit_target_pct > 0 ? `${rules.profit_target_pct.toFixed(2)}% of starting balance` : 'Funded stage — no target' },
    { label: 'Daily loss cap', value: rules.daily_drawdown_pct > 0 ? formatMoney((selectedAccount.starting_balance || selectedAccount.account_size) * (rules.daily_drawdown_pct / 100)) : 'Not set', tone: 'var(--warn)', note: rules.daily_drawdown_pct > 0 ? `${rules.daily_drawdown_pct}% of starting balance · resets 00:00 UTC` : 'No daily limit on this account' },
    { label: 'Overall loss cap', value: formatMoney((selectedAccount.starting_balance || selectedAccount.account_size) * (rules.max_drawdown_pct / 100)), tone: 'var(--loss)', note: `${rules.max_drawdown_pct}% trailing from peak equity` },
    { label: 'Time limit', value: rules.time_limit_days ? `${rules.time_limit_days} days` : 'No expiry', tone: 'var(--gain)',
      // The old flat 'No minimum trading days' note contradicted the requirement
      // card on this very page, which states the qualifying-day rule. Read it from
      // the model so the two can never disagree again.
      note: minDaysForStage > 0
        ? `${minDaysForStage} qualifying trading day${minDaysForStage === 1 ? '' : 's'} required`
        : 'No minimum trading days' },
  ] : []

  const ruleColumns = rules ? buildRuleColumns(rules, { isFundedAccount, currentModel, currentStepNumber }) : []

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ borderBottom: '3px double var(--ink)', paddingBottom: 'var(--space-4)', display: 'flex', alignItems: 'flex-end', gap: 'var(--space-5)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 'min(280px, 100%)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--accent)' }}>{kicker}</div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-6xl)', fontWeight: 400, margin: 'var(--space-2-5) 0 0' }}>The Rulebook, in full</h2>
          <p style={{ fontSize: 'var(--fs-md)', lineHeight: 1.7, color: 'var(--muted)', maxWidth: '64ch', margin: 'var(--space-2-5) 0 0' }}>
            Everything that can end this account is printed on this page. Nothing is held in a separate schedule, and nothing changes while a challenge is running.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2-5)' }}>
          <button
            onClick={() => window.print()}
            className="lx-btn"
            style={{ padding: 'var(--space-3) var(--space-4-5)', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--glass)', color: 'var(--ink)' }}
          >
            Download PDF
          </button>
          <button className="btn btn-primary" onClick={onTradeNow} style={{ padding: 'var(--space-3) var(--space-4-5)' }}>
            Open Trading Desk
          </button>
        </div>
      </div>

      {!rules ? (
        <Card style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)' }}>Loading account rules...</p>
        </Card>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3-5)' }}>
            {ruleLimits.map((r) => (
              <Card key={r.label} stat tone={r.tone}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>{r.label}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'clamp(19px,1.7vw,24px)', whiteSpace: 'nowrap', marginTop: 'var(--space-2)', color: r.tone }}>{r.value}</div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 'var(--space-1-5)', lineHeight: 1.5 }}>{r.note}</div>
              </Card>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--glass)', boxShadow: 'var(--elev)' }}>
            {ruleColumns.map((col, colIndex) => (
              <div key={col.title} style={{ padding: 'var(--space-4-5) var(--space-5) var(--space-2)', borderRight: colIndex < ruleColumns.length - 1 ? '1px solid var(--rule)' : 'none' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-3xl)', borderBottom: '1px solid var(--rule)', paddingBottom: 'var(--space-3)', marginBottom: 'var(--space-1)' }}>{col.title}</div>
                {col.items.map((item) => (
                  <div key={item.title} style={{ display: 'flex', gap: 'var(--space-3)', padding: 'var(--space-3-5) 0', borderBottom: '1px solid var(--rule-soft)' }}>
                    <span style={{ display: 'inline-flex', color: item.tone, marginTop: 'var(--space-1)' }}>
                      {renderIcon(item.icon, { size: 15, color: item.tone })}
                    </span>
                    <div>
                      <div style={{ fontSize: 'var(--fs-md)' }}>{item.title}</div>
                      <div style={{ fontSize: 'var(--fs-base)', lineHeight: 1.62, color: 'var(--muted)', marginTop: 'var(--space-1)' }}>{item.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {sortedModels.length > 0 && (
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-2xl)', borderBottom: '3px double var(--rule)', paddingBottom: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
                Targets by phase
              </div>
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

          <Card>
            <h3 style={{ color: 'var(--accent)', marginBottom: 'var(--space-3-5)', fontSize: 'var(--fs-lg)' }}>Live Status</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 var(--space-7)' }}>
              <div>
                <RuleRow label="Status" value={String(selectedAccount.status || '—').toUpperCase()} />
                <RuleRow label="Live Equity" value={formatMoney(liveEquity)} accent />
                <RuleRow label="Days Remaining" value={ruleMeta.days_remaining ?? '—'} />
                <RuleRow label="Phase End Date" value={formatDateTime(ruleMeta.phase_end_date)} />
              </div>
              <div>
                <RuleRow label="Trades Open Now" value={String(openTrades.filter(trade => trade.status === 'open').length)} />
                <RuleRow label="Pending Orders" value={String(openTrades.filter(trade => trade.status === 'pending').length)} />
                <RuleRow label="Trades Placed Today" value={String(stats?.stats?.trades_today ?? '0')} />
                <RuleRow label="Last Trade Activity" value={formatDateTime(ruleMeta.last_trade_at)} />
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
