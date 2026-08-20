import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { analyticsAPI } from '../services/api'
import ThemeToggle from '../components/ThemeToggle'
import Card from '../components/ui/Card'
import { renderIcon } from '../utils/iconMap'
import { SkeletonCard, SkeletonStats } from '../components/ui'

// Pure content — no page chrome, so it can be embedded inside the dashboard
// (DashboardCompetitionsPage.jsx, when viewing a trader from a competition
// leaderboard) as well as rendered standalone below.
export function TraderProfileContent({ userId, onBack }) {
  const navigate = useNavigate()
  const [profile, setProfile]   = useState(null)
  const [loading, setLoading]   = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!userId) { setNotFound(true); setLoading(false); return }
    setLoading(true)
    setNotFound(false)
    analyticsAPI.getTraderStats(userId)
      .then(res => setProfile(res.data))
      .catch(err => {
        if (err.response?.status === 404) setNotFound(true)
      })
      .finally(() => setLoading(false))
  }, [userId])

  function goBack() {
    if (onBack) onBack()
    else navigate('/leaderboard')
  }

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-6)' }}>
        <SkeletonCard lines={2} style={{ marginBottom: 'var(--space-6)' }} />
        <SkeletonStats count={4} />
      </div>
    )
  }

  if (notFound || !profile) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
          {renderIcon('search', { size: 40, color: 'var(--accent)' })}
        </div>
        <h2 style={{ color: 'var(--accent)', marginBottom: 'var(--space-3)' }}>Profile Not Found</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-6)' }}>This trader profile is private or does not exist.</p>
        <button onClick={goBack} className="btn" style={{ border: '1px solid var(--navy-border)', padding: 'var(--space-2-5) var(--space-6)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
          ← Back
        </button>
      </div>
    )
  }

  const { trader, stats } = profile
  const joinDate = trader.joined_at
    ? new Date(trader.joined_at).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : 'Unknown'

  const winRate = stats.total_trades > 0
    ? ((stats.winning_trades / stats.total_trades) * 100).toFixed(1)
    : '0.0'

  return (
    <div>
      <button
        onClick={goBack}
        style={{
          background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 'var(--fs-base)',
          cursor: 'pointer', padding: 0, marginBottom: 'var(--space-5)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)'
        }}
      >
        ← Back
      </button>

      {/* ── Profile Header ── */}
      <Card style={{ marginBottom: 'var(--space-5)', padding: 'var(--space-7)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
          {/* Avatar */}
          <div style={{
            width: '72px', height: '72px', borderRadius: '50%',
            background: 'color-mix(in srgb, var(--muted) 15%, transparent)',
            border: '2px solid var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 'var(--fs-5xl)', flexShrink: 0
          }}>
            {trader.full_name?.charAt(0)?.toUpperCase() || '?'}
          </div>

          {/* Name + badges */}
          <div style={{ flex: 1 }}>
    <h1 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', fontSize: 'var(--fs-3xl)', marginBottom: 'var(--space-1-5)' }}>
              {trader.full_name}
            </h1>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                {renderIcon('location', { size: 12 })} {trader.country || 'Unknown'}
              </span>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>·</span>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                {renderIcon('calendar', { size: 12 })} Joined {joinDate}
              </span>
              {trader.is_funded && (
                <span style={{
                  padding: '2px 10px', borderRadius: 'var(--radius-pill)',
                  background: 'color-mix(in srgb, var(--muted) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--muted) 30%, transparent)',
                  fontSize: 'var(--fs-xs)', color: 'var(--cyan)', fontWeight: '600',
                  display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)'
                }}>
                  {renderIcon('star', { size: 11 })} FUNDED TRADER
                </span>
              )}
              {trader.total_phases_passed > 0 && (
                <span style={{
                  padding: '2px 10px', borderRadius: 'var(--radius-pill)',
                  background: 'color-mix(in srgb, var(--muted) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--muted) 30%, transparent)',
                  fontSize: 'var(--fs-xs)', color: 'var(--accent)', fontWeight: '600',
                  display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)'
                }}>
                  {renderIcon('leaderboard', { size: 11 })} {trader.total_phases_passed} Phase{trader.total_phases_passed !== 1 ? 's' : ''} Passed
                </span>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* ── Key Stats ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
        {[
          { label: 'Total Profit',    value: `+$${parseFloat(stats.total_profit || 0).toFixed(2)}`,         color: 'var(--green)' },
          { label: 'Win Rate',        value: `${winRate}%`,                                                  color: parseFloat(winRate) >= 50 ? 'var(--green)' : 'var(--red)' },
          { label: 'Total Trades',    value: stats.total_trades || 0,                                        color: 'var(--text)' },
          { label: 'Best Trade',      value: `+$${parseFloat(stats.best_trade || 0).toFixed(2)}`,            color: 'var(--accent)' },
          { label: 'Funded Accounts', value: trader.funded_accounts || 0,                                    color: 'var(--cyan)' },
          { label: 'Challenges',      value: trader.total_accounts || 0,                                     color: 'var(--text-muted)' },
        ].map(s => (
          <div key={s.label} className="stat-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: '700', color: s.color, fontFamily: 'var(--font-mono)', marginBottom: 'var(--space-1)' }}>
              {s.value}
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', letterSpacing: '0.06em' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* ── Trading Style ── */}
      {(stats.favourite_instrument || stats.avg_hold_mins) && (
        <Card style={{ marginBottom: 'var(--space-5)' }}>
          <h3 style={{ color: 'var(--accent)', marginBottom: 'var(--space-4)', fontSize: 'var(--fs-md)', letterSpacing: '0.08em' }}>TRADING STYLE</h3>
          <div style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
            {stats.favourite_instrument && (
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--space-1)' }}>FAVOURITE INSTRUMENT</div>
            <div style={{ fontSize: '15px', fontWeight: '700', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                  {stats.favourite_instrument}
                </div>
              </div>
            )}
            {stats.avg_hold_mins && (
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--space-1)' }}>AVG HOLD TIME</div>
            <div style={{ fontSize: '15px', fontWeight: '700', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                  {stats.avg_hold_mins < 60
                    ? `${Math.round(stats.avg_hold_mins)}m`
                    : `${(stats.avg_hold_mins / 60).toFixed(1)}h`}
                </div>
              </div>
            )}
            {stats.profit_factor && (
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--space-1)' }}>PROFIT FACTOR</div>
            <div style={{ fontSize: '15px', fontWeight: '700', color: parseFloat(stats.profit_factor) >= 1.5 ? 'var(--green)' : 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                  {parseFloat(stats.profit_factor).toFixed(2)}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── Privacy notice ── */}
      <div style={{ textAlign: 'center', padding: 'var(--space-5) 0' }}>
        <p style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-sm)' }}>
          Only aggregated public statistics are shown. No personal contact information is displayed.
        </p>
      </div>
    </div>
  )
}

// Standalone full page — used for the public/direct-URL route. Nav bar is
// always shown, including while loading, so a slow/hung request never leaves
// the user on a screen with no way to navigate away.
export default function TraderProfile() {
  const { userId } = useParams()
  const navigate = useNavigate()

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--navy)' }}>
      <div className="nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
          <span className="nav-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>PROP FIRM</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <button onClick={() => navigate('/leaderboard')} style={{ background: 'transparent', border: '1px solid var(--navy-border)', color: 'var(--text-muted)', padding: '7px 16px', cursor: 'pointer', fontSize: 'var(--fs-base)' }}>
            ← Leaderboard
          </button>
          <ThemeToggle />
        </div>
      </div>

      <div style={{ maxWidth: '760px', margin: '0 auto', padding: 'var(--space-9) var(--space-6)' }}>
        <TraderProfileContent userId={userId} onBack={() => navigate('/leaderboard')} />
      </div>
    </div>
  )
}
