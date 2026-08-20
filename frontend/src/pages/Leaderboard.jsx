import React, { useState, useEffect } from 'react'
import axios from 'axios'
import { useNavigate } from 'react-router-dom'
import ThemeToggle from '../components/ThemeToggle'
import { PageWrapper } from '../App'
import { renderIcon } from '../utils/iconMap'
import Card from '../components/ui/Card'
import { API_BASE_URL as API_URL } from '../config/apiBase'


export default function Leaderboard() {
  const [leaders, setLeaders] = useState([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    axios.get(`${API_URL}/api/leaderboard`)
      .then(res => setLeaders(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <PageWrapper>
      <div style={{ minHeight: '100dvh', background: 'var(--navy)' }}>
        <div className="nav">
          <span className="nav-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>PROP FIRM</span>
          <ThemeToggle />
        </div>

        <div style={{ maxWidth: '800px', margin: '48px auto 0', padding: '0 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-8)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-3)' }}>
            {renderIcon('leaderboard', { size: 48, color: 'var(--accent-gold)' })}
          </div>
      <h1 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', fontSize: 'var(--fs-5xl)', marginBottom: 'var(--space-2)' }}>
            Leaderboard
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-md)' }}>
            Top funded traders ranked by profit percentage · Click a trader to view their profile
          </p>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px', color: 'var(--text-muted)' }}>Loading...</div>
        ) : leaders.length === 0 ? (
          <Card style={{ textAlign: 'center', padding: 'var(--space-10)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
              {renderIcon('analytics', { size: 40, color: 'var(--accent)' })}
            </div>
            <p style={{ color: 'var(--text-muted)' }}>No funded traders yet. Be the first!</p>
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {leaders.map((row, idx) => (
              <Card
                key={idx}
                interactive
                onClick={() => navigate(`/trader/${row.user_id}`)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-5)',
                  padding: 'var(--space-5) var(--space-6)',
                  borderLeft: `3px solid ${idx === 0 ? 'var(--rule)' : idx === 1 ? 'var(--rule)' : idx === 2 ? 'var(--rule)' : 'var(--navy-border)'}`,
                  background: idx === 0 ? 'color-mix(in srgb, var(--muted) 4%, transparent)' : 'var(--navy-card)',
                  cursor: 'pointer',
                  transition: 'background 0.15s'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'color-mix(in srgb, var(--muted) 6%, transparent)'}
                onMouseLeave={e => e.currentTarget.style.background = idx === 0 ? 'color-mix(in srgb, var(--muted) 4%, transparent)' : 'var(--navy-card)'}
              >
                {/* Rank */}
                <div style={{ minWidth: '36px', textAlign: 'center', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 'var(--space-1)' }}>
                  {idx < 3 ? (
                    <>
                      {renderIcon('leaderboard', { size: 18, color: idx === 0 ? 'var(--accent-gold)' : 'var(--text-secondary)' })}
                      <span style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-base)', fontWeight: '700' }}>{idx + 1}</span>
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-md)', fontWeight: '700' }}>#{idx + 1}</span>
                  )}
                </div>

                {/* Name & Country */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: '700', fontSize: '15px', color: 'var(--accent)', marginBottom: '3px' }}>
                    {row.full_name}
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', fontWeight: '400', marginLeft: 'var(--space-2)' }}>View Profile →</span>
                  </div>
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>
                    {row.country || 'Unknown'} · ${parseFloat(row.account_size).toLocaleString('en-US')} account
                  </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)', fontFamily: 'var(--font-mono)' }}>
                    Trader ID: {row.trader_uid || '—'} · Account ID: {row.account_uid || '—'}
                  </div>
                </div>

                {/* Profit % */}
                <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: '800', color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                    +{parseFloat(row.profit_pct).toFixed(2)}%
                  </div>
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>
                    +${parseFloat(row.profit_usd).toFixed(2)}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        <div style={{ textAlign: 'center', marginTop: 'var(--space-8)', marginBottom: 'var(--space-8)' }}>
          <p style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-sm)' }}>
            Rankings update in real-time · Shows top 20 active funded accounts
          </p>
        </div>
        </div>
      </div>
    </PageWrapper>
  )
}
