import React, { useState, useEffect, useCallback, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import CountUp from 'react-countup'
import { useBranding } from '../BrandingContext'
import { PageWrapper } from '../App'
import useStore from '../store/useStore'
import { renderIcon } from '../utils/iconMap'
import { accountsAPI } from '../services/api'
import { buildUnavailableAvailabilityRows, normalizeAvailabilityRows } from '../utils/accountAvailability'
import {
  calculateEquity,
  calculatePercent,
  calculateRealizedProfit,
  calculateTargetRemaining,
  formatCurrency,
  sumMoney,
} from '../utils/finance'

function formatMoney(value) {
  return formatCurrency(value)
}

function formatAnimatedCurrency(value) {
  return formatCurrency(value)
}

function formatAnimatedSignedCurrency(value) {
  return formatCurrency(value, { signed: true })
}

function formatDate(value) {
  if (!value) return 'the next period'
  try {
    return new Date(value).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  } catch {
    return 'the next period'
  }
}

function CountdownBoxes({ countdown, accent = 'var(--accent)' }) {
  return (
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      {[
        { label: 'Days', value: countdown.days },
        { label: 'Hours', value: countdown.hours },
        { label: 'Min', value: countdown.minutes },
        { label: 'Sec', value: countdown.seconds },
      ].map(item => (
        <div key={item.label} style={{ minWidth: '72px', padding: '12px 14px', borderRadius: '12px', border: '1px solid var(--navy-border)', background: 'var(--bg-hover)', textAlign: 'center' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: accent, fontFamily: 'DM Mono, monospace' }}>
            {String(item.value).padStart(2, '0')}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {item.label}
          </div>
        </div>
      ))}
    </div>
  )
}

function RuleRow({ label, value, accent = false }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '11px 0', borderBottom: '1px solid var(--navy-border)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{label}</span>
      <span style={{ color: accent ? 'var(--accent)' : 'var(--text)', fontSize: '13px', fontFamily: 'DM Mono, monospace', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function DrawdownCard({ title, usedPct, remainingPct, limitPct, tone = 'var(--accent)' }) {
  const fill = Math.min(parseFloat(usedPct || 0), 100)
  const color = fill >= 80 ? 'var(--red)' : tone
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', marginBottom: '10px' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)' }}>{title}</div>
        <div style={{ fontSize: '12px', color, fontFamily: 'DM Mono, monospace' }}>
          <CountUp
            end={fill}
            decimals={1}
            duration={1.2}
            preserveValue={true}
            useEasing={true}
          />
          % used
        </div>
      </div>
      <div style={{ height: '10px', borderRadius: '999px', background: 'var(--navy-border)', overflow: 'hidden', marginBottom: '10px' }}>
        <div style={{ height: '100%', width: `${fill}%`, background: color, transition: 'width 0.4s ease' }} />
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        Remaining: {parseFloat(remainingPct || 0).toFixed(2)}% of {parseFloat(limitPct || 0).toFixed(2)}%
      </div>
    </div>
  )
}

export default function DashboardHome({
  user,
  stats,
  openTrades: propOpenTrades = [],
  accounts: propAccounts,
  selectedAccount: propSelectedAccount,
  setSelectedAccount: propSetSelectedAccount,
  onCreateAccount,
  getStatusColor,
  profitSharePct = 80,
  quotaFull = false,
  quotaNextOpen = null,
  onOpenRulesPage
}) {
  const { tenant } = useBranding()
  const {
    prices,
    openPositions,
    totalFloatingPnL,
    activeAccount,
    allAccounts,
    setActiveAccount,
  } = useStore()
  const [availableSizes, setAvailableSizes] = useState([])
  const [sizesLoading, setSizesLoading] = useState(true)
  const [creatingSize, setCreatingSize] = useState(null)
  const [quotaTimeLeft, setQuotaTimeLeft] = useState(null)
  const [nowTick, setNowTick] = useState(Date.now())

  const accounts = allAccounts.length > 0 ? allAccounts : (propAccounts || [])
  const selectedAccount = activeAccount || propSelectedAccount
  const openTrades = openPositions.length > 0 ? openPositions : propOpenTrades
  const setSelectedAccount = useCallback((account) => {
    if (!account) return
    setActiveAccount(account)
    if (typeof propSetSelectedAccount === 'function') {
      propSetSelectedAccount(account)
    }
  }, [propSetSelectedAccount, setActiveAccount])

  const requiresPayment = tenant?.settings?.requires_payment === 'true'
  const configuredMaxAccounts = parseInt(tenant?.settings?.max_accounts_per_user || '5', 10)
  const maxAccountsPerUser = Number.isFinite(configuredMaxAccounts) && configuredMaxAccounts > 0
    ? configuredMaxAccounts
    : 1
  const activeChallengeCount = accounts.filter(
    account => account.status === 'active' && ['phase1', 'phase2', 'funded'].includes(account.account_type)
  ).length
  const canStartNewChallenge = activeChallengeCount < maxAccountsPerUser
  const hasFailedOrExpired = accounts.some(account => ['failed', 'expired'].includes(account.status))
  const isFunded = selectedAccount?.account_type === 'funded'
  const startChallengeTitle = hasFailedOrExpired
    ? 'Start a New Challenge'
    : activeChallengeCount > 0
      ? 'Start Another Challenge'
      : requiresPayment
        ? 'Start Your Challenge'
        : 'Start Your Free Challenge'
  const challengeAvailabilityMessage = activeChallengeCount > 0
    ? `Active challenge slots in use: ${activeChallengeCount} / ${maxAccountsPerUser}. You can open another challenge while you are still under your account limit.`
    : (requiresPayment
        ? 'Select an account size to begin a fresh challenge. Checkout will appear automatically if this tenant requires payment.'
        : 'Select an account size to begin a fresh Phase 1 challenge.')

  const fetchSizes = useCallback(async () => {
    setSizesLoading(true)
    try {
      const response = await accountsAPI.getAvailableSizes()
      setAvailableSizes(normalizeAvailabilityRows(response.data))
    } catch {
      setAvailableSizes(buildUnavailableAvailabilityRows())
    } finally {
      setSizesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canStartNewChallenge) return
    fetchSizes()
  }, [canStartNewChallenge, fetchSizes])

  useEffect(() => {
    if (!quotaFull || !quotaNextOpen) {
      setQuotaTimeLeft(null)
      return
    }

    function calcTimeLeft() {
      const diff = new Date(quotaNextOpen).getTime() - Date.now()
      if (diff <= 0) {
        setQuotaTimeLeft({ expired: true, days: 0, hours: 0, minutes: 0, seconds: 0 })
        return
      }
      setQuotaTimeLeft({
        expired: false,
        days: Math.floor(diff / (1000 * 60 * 60 * 24)),
        hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
        seconds: Math.floor((diff % (1000 * 60)) / 1000),
      })
    }

    calcTimeLeft()
    const iv = setInterval(calcTimeLeft, 1000)
    return () => clearInterval(iv)
  }, [quotaFull, quotaNextOpen])

  useEffect(() => {
    const iv = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  async function handleCreateAccount(size) {
    if (creatingSize) return
    setCreatingSize(size)
    try {
      await onCreateAccount(size)
      fetchSizes()
    } finally {
      setCreatingSize(null)
    }
  }

  const daysRemainingDisplay = isFunded
    ? '∞'
    : (stats?.stats?.days_remaining != null ? stats.stats.days_remaining : '—')

  const hasLivePrices = Object.keys(prices || {}).length > 0
  const floatingPnl = hasLivePrices && openPositions.length > 0
    ? totalFloatingPnL
    : openTrades
      .filter(trade => trade.status === 'open')
      .map((trade) => trade.floating_pnl || 0)
      .reduce((sum, tradePnl) => sumMoney([sum, tradePnl]), 0)
  const liveEquity = stats
    ? calculateEquity(stats.account.current_balance || 0, floatingPnl)
    : 0
  const previousFloatingPnlRef = useRef(floatingPnl)
  const floatingPnlPreviousValue = previousFloatingPnlRef.current

  useEffect(() => {
    previousFloatingPnlRef.current = floatingPnl
  }, [floatingPnl])

  const phaseCountdown = (() => {
    if (!selectedAccount?.phase_end_date || isFunded) return null
    const diff = new Date(selectedAccount.phase_end_date).getTime() - nowTick
    if (diff <= 0) return { expired: true, days: 0, hours: 0, minutes: 0, seconds: 0 }
    return {
      expired: false,
      days: Math.floor(diff / (1000 * 60 * 60 * 24)),
      hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
      minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
      seconds: Math.floor((diff % (1000 * 60)) / 1000),
    }
  })()

  const topCards = stats ? [
    {
      label: 'Current Balance',
      valueNode: (
        <CountUp
          end={parseFloat(stats.account.current_balance || 0)}
          decimals={2}
          duration={1.2}
          separator=","
          preserveValue={true}
          useEasing={true}
          formattingFn={formatAnimatedCurrency}
        />
      ),
      color: 'var(--text-primary)',
      icon: 'balance',
      iconColor: 'var(--accent)'
    },
    { label: 'Live Equity', value: formatMoney(liveEquity), color: floatingPnl >= 0 ? 'var(--green)' : 'var(--red)', icon: floatingPnl >= 0 ? 'floating_up' : 'floating_down', iconColor: floatingPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' },
    {
      label: 'Floating P&L',
      valueNode: (
        <CountUp
          start={floatingPnlPreviousValue}
          end={floatingPnl}
          decimals={2}
          duration={1.2}
          separator=","
          preserveValue={true}
          useEasing={true}
          formattingFn={formatAnimatedSignedCurrency}
        />
      ),
      color: floatingPnl >= 0 ? 'var(--green)' : 'var(--red)',
      icon: floatingPnl >= 0 ? 'floating_up' : 'floating_down',
      iconColor: floatingPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'
    },
    { label: 'Profit', value: `${parseFloat(stats.stats.profit_pct || 0) >= 0 ? '+' : ''}${parseFloat(stats.stats.profit_pct || 0).toFixed(2)}%`, color: parseFloat(stats.stats.profit_pct || 0) >= 0 ? 'var(--green)' : 'var(--red)', icon: 'target', iconColor: 'var(--accent)' },
    { label: 'Trades Today', value: String(stats.stats.trades_today ?? 0), color: 'var(--accent)', icon: 'activity', iconColor: 'var(--accent)' },
    { label: 'Days Remaining', value: String(daysRemainingDisplay), color: 'var(--text-primary)', icon: 'calendar', iconColor: 'var(--accent)' },
  ] : []

  const profitTargetAmount = stats ? Number(stats.account.profit_target || 0) : 0
  const startingBalance = stats ? Number(stats.account.starting_balance || 0) : 0
  const realizedProfit = stats
    ? calculateRealizedProfit(stats.account.current_balance || 0, startingBalance)
    : 0
  const profitProgressPct = calculatePercent(realizedProfit, profitTargetAmount, {
    clampMin: 0,
    clampMax: 100,
    decimalPlaces: 1
  })
  const drawdownUsedPct = parseFloat(stats?.stats?.total_drawdown_used_pct || 0)
  const showWarning = Boolean(stats && !isFunded && drawdownUsedPct >= 75)
  const warningTone = drawdownUsedPct >= 90 ? 'var(--red)' : 'var(--accent)'
  const warningMessage = drawdownUsedPct >= 90
    ? `Critical warning: ${drawdownUsedPct.toFixed(1)}% of your total drawdown limit is already used.`
    : `Drawdown warning: ${drawdownUsedPct.toFixed(1)}% of your total drawdown limit is already used.`

  return (
    <PageWrapper>
      <div>
      <h2 className="page-title">Account Overview</h2>

      {accounts.length > 0 && (
        <div style={{ display: 'flex', gap: '16px', marginBottom: '28px', flexWrap: 'wrap' }}>
          {accounts.map(account => {
            const isSelected = selectedAccount?.id === account.id
            return (
              <button
                key={account.id}
                onClick={() => setSelectedAccount(account)}
                style={{
                  background: isSelected ? 'var(--accent)' : 'var(--bg-elevated)',
                  color: isSelected ? '#fff' : 'var(--text-primary)',
                  border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                  padding: '16px 20px',
                  borderRadius: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.3s',
                  boxShadow: isSelected ? '0 8px 24px var(--accent-glow)' : 'none',
                  minWidth: '190px'
                }}
              >
                <div style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '0.02em' }}>
                  {account.account_type.toUpperCase()} ${parseFloat(account.account_size).toLocaleString('en-US')}
                </div>
                <div style={{ fontSize: '12px', fontFamily: 'DM Mono, monospace', color: isSelected ? 'rgba(255,255,255,0.72)' : 'var(--text-muted)' }}>
                  #{account.account_uid ? account.account_uid.slice(0, 8) : account.id}
                </div>
                <span style={{
                  marginTop: '6px',
                  fontSize: '10px',
                  fontWeight: 800,
                  letterSpacing: '0.1em',
                  color: isSelected ? '#fff' : getStatusColor(account.status),
                  background: isSelected ? 'rgba(255,255,255,0.18)' : 'var(--bg-hover)',
                  padding: '4px 8px',
                  borderRadius: '6px'
                }}>
                  • {account.status.toUpperCase()}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {canStartNewChallenge && quotaFull && (
        <div className="card" style={{ marginBottom: '24px', border: '1px solid rgba(97, 97, 97, 0.4)', background: 'rgba(97, 97, 97, 0.04)' }}>
          <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
            <h3 style={{ color: 'var(--red)', marginBottom: '8px' }}>Account Creation Closed</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '18px' }}>
              The maximum number of new accounts for this period has been reached.
            </p>
            {quotaTimeLeft && !quotaTimeLeft.expired && (
              <>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: '12px' }}>
                  NEW ACCOUNTS OPEN IN
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <CountdownBoxes countdown={quotaTimeLeft} accent="var(--accent)" />
                </div>
                <div style={{ marginTop: '14px', fontSize: '12px', color: 'var(--text-dim)' }}>
                  Next open: {formatDate(quotaNextOpen)}
                </div>
              </>
            )}
            {quotaTimeLeft?.expired && (
              <div style={{ color: 'var(--green)', fontSize: '13px' }}>
                Quota has reset. Refresh the page to start a new challenge.
              </div>
            )}
          </div>
        </div>
      )}

      {canStartNewChallenge && !quotaFull && (
        <div className="card" style={{ marginBottom: '24px', border: hasFailedOrExpired ? '1px solid var(--accent)' : undefined }}>
          <h3 style={{ marginBottom: '12px', color: hasFailedOrExpired ? 'var(--accent)' : 'var(--text-primary)' }}>
            {startChallengeTitle}
          </h3>
          <p style={{ color: 'var(--text-muted)', marginBottom: '20px' }}>
            {challengeAvailabilityMessage}
          </p>

          {sizesLoading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '14px', padding: '20px 0' }}>Loading available sizes...</div>
          ) : (
            <div className="grid-6">
              {availableSizes.map(({ size, locked, remaining, quota, reason, is_unlimited: isUnlimited }) => {
                const isCreating = creatingSize === size
                const usedPct = quota && remaining != null ? Math.min(((quota - remaining) / quota) * 100, 100) : 0
                return (
                  <div
                    key={size}
                    className="card-stat card-hover"
                    onClick={() => !locked && !isCreating && handleCreateAccount(size)}
                    style={{
                      cursor: locked ? 'not-allowed' : isCreating ? 'wait' : 'pointer',
                      opacity: locked ? 0.45 : 1,
                      border: locked ? '1px solid #8a8a8a' : undefined
                    }}
                  >
                    {locked && (
                      <div className="badge badge-neutral" style={{ position: 'absolute', top: '6px', right: '6px' }}>
                        FULL
                      </div>
                    )}
                    <div className="card-stat-value" style={{ color: 'var(--accent)' }}>${size.toLocaleString('en-US')}</div>
                    <div className="card-stat-title" style={{ marginTop: '4px', color: locked ? '#8a8a8a' : 'var(--text-muted)' }}>
                      {locked
                        ? (reason || 'No slots left')
                        : isCreating
                          ? 'Creating...'
                          : isUnlimited || remaining === null
                            ? 'Unlimited slots'
                            : `${remaining} slot${remaining !== 1 ? 's' : ''} left`}
                    </div>
                    {!locked && !isUnlimited && quota !== null && remaining !== null && (
                      <div className="progress-bar" style={{ marginTop: '8px' }}>
                        <div className="progress-fill" style={{ width: `${usedPct}%` }} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {!canStartNewChallenge && (
        <div className="card" style={{ marginBottom: '24px', border: '1px solid rgba(97, 97, 97, 0.4)', background: 'rgba(97, 97, 97, 0.04)' }}>
          <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
            <h3 style={{ color: 'var(--text-primary)', marginBottom: '8px' }}>Challenge Limit Reached</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: 0 }}>
              You are already using {activeChallengeCount} of {maxAccountsPerUser} active challenge slot{maxAccountsPerUser === 1 ? '' : 's'}. Close, fail, or complete one of your active accounts before starting another challenge.
            </p>
          </div>
        </div>
      )}

      {!canStartNewChallenge && selectedAccount && selectedAccount.status === 'active' && !stats && (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Loading account stats...</p>
        </div>
      )}

      {stats && selectedAccount && (
        <div>
          <AnimatePresence>
            {showWarning && (
              <motion.div
                initial={{ opacity: 0, y: -16, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, y: -16, height: 0 }}
                transition={{ duration: 0.3 }}
                style={{ overflow: 'hidden' }}
              >
                <div
                  className="card"
                  style={{
                    marginBottom: '24px',
                    border: `1px solid ${warningTone}`,
                    background: 'rgba(17, 24, 39, 0.72)'
                  }}
                >
                  <h3 style={{ color: warningTone, marginBottom: '8px' }}>Drawdown Warning</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: 0 }}>
                    {warningMessage}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            {topCards.map((card, index) => (
              <motion.div
                key={card.label}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.08, duration: 0.3 }}
              >
                <div className="card-stat" style={{ position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '4px', background: card.color }} />
                  <div className="card-stat-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ display: 'inline-flex', opacity: 0.8 }}>
                      {renderIcon(card.icon, { size: 14, color: card.iconColor || 'var(--accent)' })}
                    </span>
                    <span>{card.label}</span>
                  </div>
                  <div className="card-stat-value" style={{ marginTop: '8px', color: card.color }}>
                    {card.valueNode || card.value}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {phaseCountdown && (
            <div className="card" style={{ marginBottom: '24px', border: phaseCountdown.expired ? '1px solid var(--red)' : '1px solid var(--navy-border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '11px', letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: '8px' }}>
                    Challenge Expiry Countdown
                  </div>
                  <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                    {phaseCountdown.expired ? 'This phase has reached its end time.' : 'This timer updates every second so you can see the exact time left.'}
                  </div>
                </div>
                <CountdownBoxes countdown={phaseCountdown} accent={phaseCountdown.expired ? 'var(--red)' : 'var(--accent)'} />
              </div>
            </div>
          )}

          {!isFunded && (
            <div className="card" style={{ marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>Profit Target Progress</span>
                <span style={{ fontSize: '13px', color: 'var(--accent)', fontWeight: 700, fontFamily: 'DM Mono, monospace' }}>
                  <CountUp
                    end={profitProgressPct}
                    decimals={1}
                    duration={1.2}
                    preserveValue={true}
                    useEasing={true}
                  />
                  % complete
                </span>
              </div>
              <div style={{ height: '10px', borderRadius: '999px', background: 'var(--navy-border)', overflow: 'hidden', marginBottom: '10px' }}>
                <div style={{ height: '100%', width: `${profitProgressPct}%`, background: 'linear-gradient(90deg, var(--green), var(--accent))', transition: 'width 0.4s ease' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--text-muted)' }}>
                <span>Earned: <strong style={{ color: realizedProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatMoney(realizedProfit)}</strong></span>
                <span>Target: <strong style={{ color: 'var(--accent)' }}>{formatMoney(profitTargetAmount)}</strong></span>
                <span>Remaining: <strong style={{ color: 'var(--text)' }}>{formatMoney(Math.max(0, profitTargetAmount - realizedProfit))}</strong></span>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <DrawdownCard
              title="Total Drawdown Remaining"
              usedPct={stats.stats.total_drawdown_used_pct}
              remainingPct={stats.stats.total_drawdown_remaining_pct}
              limitPct={stats.rules?.max_drawdown_pct || stats.account.max_drawdown_pct}
            />
          </div>

          <div className="grid-2">
            <div className="card">
              <h3 style={{ color: 'var(--accent)', marginBottom: '16px', fontSize: '15px' }}>Account Info</h3>
              <RuleRow label="Trader ID" value={user?.trader_uid || user?.trader_id || '—'} />
              <RuleRow label="Account ID" value={selectedAccount.account_uid || selectedAccount.id || '—'} />
              <RuleRow label="Account Type" value={selectedAccount.account_type.toUpperCase()} />
              <RuleRow label="Account Size" value={`$${parseFloat(selectedAccount.account_size || 0).toLocaleString('en-US')}`} />
              <RuleRow label="Starting Balance" value={formatMoney(stats.account.starting_balance)} />
              <RuleRow label="Current Balance" value={formatMoney(stats.account.current_balance)} />
              <RuleRow label="Live Equity" value={formatMoney(liveEquity)} accent />
              <RuleRow label="Status" value={String(selectedAccount.status || '—').toUpperCase()} />
            </div>

            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
                <h3 style={{ color: 'var(--accent)', margin: 0, fontSize: '15px' }}>
                  {isFunded ? 'Funded Account Rules' : 'Challenge Rules'}
                </h3>
                <button className="btn btn-secondary" onClick={onOpenRulesPage} style={{ padding: '8px 12px', fontSize: '12px' }}>
                  Full Rules
                </button>
              </div>
              <RuleRow label="Profit Target" value={stats.rules?.profit_target_pct > 0 ? `${parseFloat(stats.rules.profit_target_pct || 0).toFixed(2)}%` : 'No target'} accent />
              <RuleRow label="Max Drawdown" value={`${parseFloat(stats.rules?.max_drawdown_pct || stats.account.max_drawdown_pct || 0).toFixed(2)}%`} />
              <RuleRow label="Time Limit" value={stats.rules?.time_limit_days ? `${stats.rules.time_limit_days} days` : 'No expiry'} />
              <RuleRow label="Max Daily Trades" value={`${stats.rules?.max_daily_trades || 20} per UTC day`} />
              <RuleRow label="Min Hold Time" value={`${stats.rules?.min_hold_seconds || 60} seconds`} />
              <RuleRow label="Forex Lots per $1k" value={parseFloat(stats.rules?.forex_lots_per_1k || 0.2).toFixed(2)} />
              <RuleRow label="Commodity Lots per $1k" value={parseFloat(stats.rules?.commodity_lots_per_1k || 0.02).toFixed(2)} />
              <RuleRow label="Profit Split" value={`${profitSharePct}%`} />
            </div>
          </div>
        </div>
      )}

      {selectedAccount?.status === 'locked' && (
        <div className="card" style={{ textAlign: 'center', padding: '32px', border: '1px solid #8a8a8a', marginTop: '20px' }}>
          <h3 style={{ color: '#8a8a8a', marginBottom: '8px' }}>Account Locked</h3>
          <p style={{ color: 'var(--text-muted)' }}>This account has been locked by admin. Contact support for assistance.</p>
        </div>
      )}
      </div>
    </PageWrapper>
  )
}
