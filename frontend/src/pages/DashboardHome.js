import React, { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

export default function DashboardHome({ user, stats, accounts, selectedAccount, setSelectedAccount, onCreateAccount, getStatusColor, profitSharePct = 80, quotaFull = false, quotaNextOpen = null }) {

  const [availableSizes, setAvailableSizes] = useState([])
  const [sizesLoading, setSizesLoading]     = useState(true)
  const [creatingSize, setCreatingSize]     = useState(null)
  // FIX (LOW #31): Use destructured hooks consistently instead of mixing React.useState
  const [quotaTimeLeft, setQuotaTimeLeft] = useState(null)

  const hasActiveChallenge = accounts.some(
    a => a.status === 'active' && ['phase1', 'phase2', 'funded'].includes(a.account_type)
  )
  const canStartNewChallenge = !hasActiveChallenge
  const hasFailedOrExpired   = accounts.some(a => ['failed', 'expired'].includes(a.status))

  const fetchSizes = useCallback(() => {
    setSizesLoading(true)
    axios.get(`${API_URL}/api/accounts/available-sizes`)
      .then(res => setAvailableSizes(res.data))
      .catch(() => {
        setAvailableSizes([1000, 2000, 5000, 10000, 25000, 100000].map(size => ({
          size, locked: false, remaining: null, quota: null
        })))
      })
      .finally(() => setSizesLoading(false))
  }, [])

  useEffect(() => {
    if (!canStartNewChallenge) return
    fetchSizes()
  }, [canStartNewChallenge, fetchSizes])

  useEffect(() => {
    if (!canStartNewChallenge) return
    fetchSizes()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts])

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

  // eslint-disable-next-line no-unused-vars
  function getProfitBarWidth() {
    if (!stats) return 0
    const profitTarget    = parseFloat(stats.account.profit_target || 0)
    const startingBalance = parseFloat(stats.account.starting_balance || 1)
    if (profitTarget <= 0) return 0
    const targetPct = (profitTarget / startingBalance) * 100
    return Math.min(Math.max((stats.stats.profit_pct / targetPct) * 100, 0), 100)
  }

  function getProfitTargetLabel() {
    if (!stats) return '—'
    const profitTarget    = parseFloat(stats.account.profit_target || 0)
    const startingBalance = parseFloat(stats.account.starting_balance || 1)
    if (profitTarget <= 0) return 'N/A'
    return `${((profitTarget / startingBalance) * 100).toFixed(0)}%`
  }

  function formatNextOpen(dateStr) {
    if (!dateStr) return 'the start of next month'
    try {
      return new Date(dateStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    } catch { return 'the start of next month' }
  }

  useEffect(() => {
    if (!quotaFull || !quotaNextOpen) { setQuotaTimeLeft(null); return }

    function calcTimeLeft() {
      const diff = new Date(quotaNextOpen) - new Date()
      if (diff <= 0) { setQuotaTimeLeft({ expired: true }); return }
      const days    = Math.floor(diff / (1000 * 60 * 60 * 24))
      const hours   = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
      const seconds = Math.floor((diff % (1000 * 60)) / 1000)
      setQuotaTimeLeft({ days, hours, minutes, seconds, expired: false })
    }

    calcTimeLeft()
    const iv = setInterval(calcTimeLeft, 1000)
    return () => clearInterval(iv)
  }, [quotaFull, quotaNextOpen])

  const isFunded = selectedAccount?.account_type === 'funded'

  const daysRemainingDisplay = isFunded
    ? '∞'
    : (stats?.stats?.days_remaining != null ? stats.stats.days_remaining : '—')

  return (
    <div>
      <h2 className="page-title">
        Account Overview
      </h2>

      {/* ── Account Selector ── */}
      {accounts.length > 0 && (
        <div style={{ display: 'flex', gap: '16px', marginBottom: '32px', flexWrap: 'wrap' }}>
          {accounts.map(acc => {
            const isSelected = selectedAccount?.id === acc.id;
            return (
              <button key={acc.id} onClick={() => setSelectedAccount(acc)}
                style={{
                  background: isSelected ? 'var(--accent)' : 'var(--bg-elevated)',
                  color:      isSelected ? '#fff' : 'var(--text-primary)',
                  border:     `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                  padding:    '16px 20px',
                  borderRadius: '16px',
                  display:    'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap:        '4px',
                  cursor:     'pointer',
                  transition: 'all 0.3s',
                  boxShadow:  isSelected ? '0 8px 24px var(--accent-glow)' : 'none',
                  minWidth:   '180px'
                }}>
                <div style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '0.02em' }}>
                  {acc.account_type.toUpperCase()} ${parseFloat(acc.account_size).toLocaleString('en-US')}
                </div>
                <div style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: isSelected ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)' }}>
                  #{acc.account_uid ? acc.account_uid.slice(0, 8) : acc.id}
                </div>
                <span style={{ 
                  marginTop: '8px', 
                  fontSize: '10px', 
                  fontWeight: 800, 
                  letterSpacing: '0.1em', 
                  color: isSelected ? '#fff' : getStatusColor(acc.status),
                  background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--bg-hover)',
                  padding: '4px 8px',
                  borderRadius: '6px'
                }}>
                  ● {acc.status.toUpperCase()}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* ── Quota full banner with live countdown ── */}
      {canStartNewChallenge && quotaFull && (
        <div className="card" style={{ marginBottom: '24px', border: '1px solid rgba(97, 97, 97, 0.4)', background: 'rgba(97, 97, 97, 0.04)' }}>
          <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
            <div style={{ fontSize: '36px', marginBottom: '10px' }}>🚫</div>
            <h3 style={{ color: 'var(--red)', marginBottom: '8px' }}>Account Creation Closed</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
              The maximum number of new accounts for this period has been reached.
            </p>

            {/* Countdown blocks */}
            {quotaTimeLeft && !quotaTimeLeft.expired && (
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: '12px' }}>
                  NEW ACCOUNTS OPEN IN
                </div>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
                  {[
                    { value: quotaTimeLeft.days,    label: 'DAYS' },
                    { value: quotaTimeLeft.hours,   label: 'HOURS' },
                    { value: quotaTimeLeft.minutes, label: 'MIN' },
                    { value: quotaTimeLeft.seconds, label: 'SEC' },
                  ].map(({ value, label }) => (
                    <div key={label} style={{
                      background: 'var(--navy)',
                      border: '1px solid var(--navy-border)',
                      borderRadius: '8px',
                      padding: '12px 16px',
                      minWidth: '64px', textAlign: 'center'
                    }}>
                      <div style={{ fontSize: '24px', fontWeight: '800', color: 'var(--accent)', fontFamily: 'DM Mono, monospace', lineHeight: 1 }}>
                        {String(value).padStart(2, '0')}
                      </div>
                      <div style={{ fontSize: '9px', color: 'var(--text-dim)', marginTop: '4px', letterSpacing: '0.1em' }}>
                        {label}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: '14px', fontSize: '12px', color: 'var(--text-dim)' }}>
                  Next open: {formatNextOpen(quotaNextOpen)}
                </div>
              </div>
            )}

            {quotaTimeLeft?.expired && (
              <div style={{ color: 'var(--green)', fontSize: '13px' }}>
                ✅ Quota has reset — please refresh the page to start a new challenge.
              </div>
            )}

            {!quotaTimeLeft && (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                New accounts can be created from <strong>{formatNextOpen(quotaNextOpen)}</strong>.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Start New Challenge ── */}
      {canStartNewChallenge && !quotaFull && (
        <div className="card" style={{ marginBottom: '24px', border: hasFailedOrExpired ? '1px solid var(--accent)' : undefined }}>
          {hasFailedOrExpired ? (
            <>
              <div style={{ fontSize: '32px', marginBottom: '8px' }}>🔄</div>
              <h3 style={{ marginBottom: '8px', color: 'var(--accent)' }}>Start a New Challenge</h3>
              <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '14px' }}>
                Your previous challenge has ended. Select a size below to begin a fresh Phase 1:
              </p>
            </>
          ) : (
            <>
              <h3 style={{ marginBottom: '12px' }}>Start Your Free Challenge</h3>
              <p style={{ color: 'var(--text-muted)', marginBottom: '20px' }}>Select your account size to begin Phase 1:</p>
            </>
          )}

          {sizesLoading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '14px', padding: '20px 0' }}>Loading available sizes...</div>
          ) : (
            <div className="grid-6">
              {availableSizes.map(({ size, locked, remaining, quota }) => {
                const isCreating = creatingSize === size
                return (
                  <div
                    key={size}
                    className="card-stat card-hover"
                    onClick={() => !locked && !isCreating && handleCreateAccount(size)}
                    style={{
                      cursor:     locked ? 'not-allowed' : isCreating ? 'wait' : 'pointer',
                      opacity:    locked ? 0.45 : 1,
                      border:     locked ? '1px solid #8a8a8a' : undefined
                    }}
                  >
                    {/* Lock badge */}
                    {locked && (
                      <div className="badge badge-neutral" style={{ position: 'absolute', top: '6px', right: '6px' }}>
                        FULL
                      </div>
                    )}

                    <div className="card-stat-value" style={{ color: 'var(--accent)' }}>
                      ${size.toLocaleString('en-US')}
                    </div>
                    <div className="card-stat-title" style={{ marginTop: '4px', color: locked ? '#8a8a8a' : 'var(--text-muted)' }}>
                      {locked
                        ? 'No slots left'
                        : isCreating
                          ? 'Creating...'
                          : remaining === null
                            ? 'Unlimited slots'
                            : `${remaining} slot${remaining !== 1 ? 's' : ''} left`
                      }
                    </div>

                    {/* Slot progress bar */}
                    {!locked && quota !== null && remaining !== null && (
                      <div className="progress-bar" style={{ marginTop: '8px' }}>
                        <div className={`progress-fill ${remaining <= 5 ? 'progress-danger' : remaining <= Math.ceil(quota * 0.2) ? 'progress-warning' : 'progress-success'}`} style={{
                          width:  `${Math.min(((quota - remaining) / quota) * 100, 100)}%`,
                        }} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Active challenge running — blocked ── */}
      {!canStartNewChallenge && accounts.length > 0 && selectedAccount && ['failed', 'expired', 'passed'].includes(selectedAccount.status) && (
        <div className="card" style={{ marginBottom: '24px', border: '1px solid var(--navy-border)', textAlign: 'center', padding: '24px' }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>⏳</div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
            You have an active challenge running. Complete it before starting a new one.
          </p>
        </div>
      )}

      {/* ── Loading state: account is active but stats haven't arrived yet ── */}
      {!canStartNewChallenge && selectedAccount && selectedAccount.status === 'active' && !stats && (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Loading account stats...</p>
        </div>
      )}

      {/* ── Stats ── */}
      {stats && selectedAccount && (
        <div>
          <div className="grid-4" style={{ marginBottom: '24px' }}>
            <div className="card-stat" style={{ position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '4px', background: 'linear-gradient(90deg, var(--accent), var(--info))' }} />
              <div className="card-stat-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
                Current Balance <span style={{ fontSize: '18px' }}>💰</span>
              </div>
              <div className="card-stat-value" style={{ marginTop: '8px' }}>${parseFloat(stats.account.current_balance).toFixed(2)}</div>
            </div>
            <div className="card-stat" style={{ position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '4px', background: stats.stats.profit_pct >= 0 ? 'var(--success)' : 'var(--danger)' }} />
              <div className="card-stat-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
                {isFunded ? 'Profit Earned' : `Profit (Target ${getProfitTargetLabel()})`} <span style={{ fontSize: '18px' }}>📈</span>
              </div>
              <div className={`card-stat-value ${stats.stats.profit_pct >= 0 ? 'pnl-positive' : 'pnl-negative'}`} style={{ marginTop: '8px' }}>
                {stats.stats.profit_pct >= 0 ? '+' : ''}{stats.stats.profit_pct}%
              </div>
            </div>
            <div className="card-stat" style={{ position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '4px', background: stats.stats.drawdown_pct > 7 ? 'var(--danger)' : 'var(--warning)' }} />
              <div className="card-stat-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
                Drawdown (Max {stats.account.max_drawdown_pct}%) <span style={{ fontSize: '18px' }}>📉</span>
              </div>
              <div className="card-stat-value" style={{ marginTop: '8px', color: stats.stats.drawdown_pct > 7 ? 'var(--danger)' : 'var(--text-primary)' }}>
                -{stats.stats.drawdown_pct}%
              </div>
            </div>
            <div className="card-stat" style={{ position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '4px', background: 'linear-gradient(90deg, var(--bg-hover), var(--border))' }} />
              <div className="card-stat-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
                Days Remaining <span style={{ fontSize: '18px' }}>⏳</span>
              </div>
              <div className="card-stat-value" style={{ marginTop: '8px' }}>{daysRemainingDisplay}</div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: '24px' }}>
            {!isFunded && (
              <>
                {(() => {
                  const profitTarget    = parseFloat(stats.account.profit_target || 0)
                  const startingBalance = parseFloat(stats.account.starting_balance || 1)
                  const currentBalance  = parseFloat(stats.account.current_balance || startingBalance)
                  const realizedProfit  = currentBalance - startingBalance
                  const progressPct     = profitTarget > 0
                    ? Math.min(Math.max((realizedProfit / profitTarget) * 100, 0), 100)
                    : 0
                  const targetPct       = profitTarget > 0
                    ? ((profitTarget / startingBalance) * 100).toFixed(0)
                    : '—'
                  const barColor        = progressPct >= 100 ? 'var(--accent)'
                    : progressPct >= 75  ? '#797979'
                    : progressPct >= 50  ? '#676767'
                    : progressPct >= 25  ? '#8b8b8b'
                    : 'var(--green)'

                  return (
                    <div style={{ marginBottom: '20px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: '600' }}>
                          🎯 Profit Target Progress
                        </span>
                        <span style={{ fontSize: '13px', color: barColor, fontWeight: '700', fontFamily: 'DM Mono, monospace' }}>
                          {progressPct.toFixed(1)}% complete
                        </span>
                      </div>

                      <div style={{ position: 'relative', marginBottom: '6px' }}>
                        <div style={{
                          height: '10px', borderRadius: '5px',
                          background: 'var(--navy-border)', overflow: 'visible',
                          position: 'relative'
                        }}>
                          <div style={{
                            height: '100%', borderRadius: '5px',
                            width: `${progressPct}%`,
                            background: `linear-gradient(90deg, var(--green), ${barColor})`,
                            transition: 'width 0.5s ease',
                            position: 'relative'
                          }}>
                            {progressPct > 0 && progressPct < 100 && (
                              <div style={{
                                position: 'absolute', right: '-1px', top: '-2px',
                                width: '4px', height: '14px', borderRadius: '2px',
                                background: barColor,
                                boxShadow: `0 0 8px ${barColor}`,
                              }} />
                            )}
                          </div>

                          {[25, 50, 75].map(milestone => (
                            <div key={milestone} style={{
                              position: 'absolute', top: '-3px',
                              left: `${milestone}%`,
                              transform: 'translateX(-50%)',
                              width: '2px', height: '16px',
                              background: progressPct >= milestone ? barColor : 'var(--navy-hover)',
                              borderRadius: '1px', zIndex: 1
                            }} />
                          ))}
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', paddingLeft: '25%', paddingRight: '25%' }}>
                          {[25, 50, 75].map(milestone => (
                            <span key={milestone} style={{
                              fontSize: '9px',
                              color: progressPct >= milestone ? barColor : 'var(--text-dim)',
                              fontFamily: 'DM Mono, monospace',
                              transform: 'translateX(-50%)',
                              display: 'block'
                            }}>
                              {milestone}%
                            </span>
                          ))}
                        </div>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          Earned:{' '}
                          <span style={{ color: realizedProfit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: '600', fontFamily: 'DM Mono, monospace' }}>
                            {realizedProfit >= 0 ? '+' : ''}${realizedProfit.toFixed(2)}
                          </span>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          Target:{' '}
                          <span style={{ color: 'var(--accent)', fontWeight: '600', fontFamily: 'DM Mono, monospace' }}>
                            +${profitTarget.toFixed(2)} ({targetPct}%)
                          </span>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          Remaining:{' '}
                          <span style={{ color: 'var(--text)', fontWeight: '600', fontFamily: 'DM Mono, monospace' }}>
                            ${Math.max(0, profitTarget - realizedProfit).toFixed(2)}
                          </span>
                        </div>
                      </div>

                      {progressPct >= 100 && (
                        <div style={{
                          marginTop: '10px', padding: '8px 14px',
                          background: 'rgba(148, 148, 148, 0.12)',
                          border: '1px solid var(--accent)',
                          borderRadius: '6px', textAlign: 'center',
                          fontSize: '13px', color: 'var(--accent)', fontWeight: '600'
                        }}>
                          🏆 Profit target reached! Close all trades to advance.
                        </div>
                      )}
                      {progressPct >= 75 && progressPct < 100 && (
                        <div style={{
                          marginTop: '10px', padding: '6px 12px',
                          background: 'rgba(121, 121, 121, 0.08)',
                          border: '1px solid rgba(121, 121, 121, 0.3)',
                          borderRadius: '6px', textAlign: 'center',
                          fontSize: '12px', color: '#797979'
                        }}>
                          Almost there! ${(profitTarget - realizedProfit).toFixed(2)} more to hit your target.
                        </div>
                      )}
                    </div>
                  )
                })()}
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Drawdown Risk</span>
              <span style={{ fontSize: '13px', color: 'var(--red)' }}>
                {stats.stats.drawdown_pct}% / {stats.account.max_drawdown_pct}%
              </span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{
                width:      `${Math.min((stats.stats.drawdown_pct / stats.account.max_drawdown_pct) * 100, 100)}%`,
                background: 'var(--red)'
              }} />
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <h3 style={{ color: 'var(--accent)', marginBottom: '16px', fontSize: '15px' }}>Account Info</h3>
              {[
                { label: 'Trader ID',       value: user?.trader_uid || user?.trader_id || '—' },
                { label: 'Account ID',      value: selectedAccount.account_uid || selectedAccount.id || '—' },
                { label: 'Account Type',     value: selectedAccount.account_type.toUpperCase() },
                { label: 'Account Size',     value: `$${parseFloat(selectedAccount.account_size).toLocaleString('en-US')}` },
                { label: 'Starting Balance', value: `$${parseFloat(stats.account.starting_balance).toFixed(2)}` },
                { label: 'Current Balance',  value: `$${parseFloat(stats.account.current_balance).toFixed(2)}` },
                { label: 'Status',           value: selectedAccount.status.toUpperCase() },
              ].map(row => {
                const isIdRow = row.label === 'Trader ID' || row.label === 'Account ID'
                return (
                  <div
                    key={row.label}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: isIdRow ? 'flex-start' : 'center',
                      gap: '12px',
                      padding: '10px 0',
                      borderBottom: '1px solid var(--navy-border)'
                    }}
                  >
                    <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                      {row.label}
                    </span>
                    <span
                      style={{
                        color: 'var(--text)',
                        fontSize: '13px',
                        fontWeight: '500',
                        fontFamily: 'DM Mono, monospace',
                        lineHeight: 1.3,
                        textAlign: 'right',
                        maxWidth: isIdRow ? '72%' : 'unset',
                        wordBreak: isIdRow ? 'break-all' : 'normal'
                      }}
                    >
                      {row.value}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="card">
              <h3 style={{ color: 'var(--accent)', marginBottom: '16px', fontSize: '15px' }}>
                {isFunded ? 'Funded Account Rules' : 'Challenge Rules'}
              </h3>
              {(isFunded ? [
                { label: 'Max Drawdown',          value: `${stats.account.max_drawdown_pct}%` },
                { label: 'Profit Target',          value: 'None' },
                { label: 'Time Limit',             value: 'None' },
                { label: 'Forex Leverage',         value: '1:30' },
                { label: 'Gold/Silver Leverage',   value: '1:10' },
                { label: 'Max Forex Lots/1k',      value: '0.20 combined' },
                { label: 'Max Commodity Lots/1k',  value: '0.02 combined' },
                { label: 'Profit Split',           value: `${profitSharePct}%` },
              ] : [
                { label: 'Profit Target',          value: getProfitTargetLabel() },
                { label: 'Max Drawdown',           value: `${stats.account.max_drawdown_pct}%` },
                { label: 'Days Remaining',         value: daysRemainingDisplay },
                { label: 'Forex Leverage',         value: '1:30' },
                { label: 'Gold/Silver Leverage',   value: '1:10' },
                { label: 'Max Forex Lots/1k',      value: '0.20 combined' },
                { label: 'Max Commodity Lots/1k',  value: '0.02 combined' },
                { label: 'Profit Split',           value: `${profitSharePct}%` },
              ]).map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--navy-border)' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{row.label}</span>
                  <span style={{ color: 'var(--text)', fontSize: '13px', fontFamily: 'DM Mono, monospace' }}>{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Account Locked ── */}
      {selectedAccount?.status === 'locked' && (
        <div className="card" style={{ textAlign: 'center', padding: '32px', border: '1px solid #8a8a8a', marginTop: '20px' }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>🔒</div>
          <h3 style={{ color: '#8a8a8a', marginBottom: '8px' }}>Account Locked</h3>
          <p style={{ color: 'var(--text-muted)' }}>This account has been locked by admin. Contact support for assistance.</p>
        </div>
      )}
    </div>
  )
}
