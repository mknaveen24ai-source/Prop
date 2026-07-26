import React, { useState, useEffect } from 'react'
import axios from 'axios'
import { useNavigate } from 'react-router-dom'
import ThemeToggle from '../components/ThemeToggle'
import { PageWrapper } from '../App'
import { renderIcon } from '../utils/iconMap'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

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
      <div style={{ minHeight: '100vh', background: 'var(--navy)' }}>
        <div className="nav">
          <span className="nav-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>PROP FIRM</span>
          <ThemeToggle />
        </div>

        <div className="container" style={{ maxWidth: '800px', marginTop: '48px' }}>
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
            {renderIcon('leaderboard', { size: 48, color: 'var(--accent-gold)' })}
          </div>
      <h1 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', fontSize: '28px', marginBottom: '8px' }}>
            Leaderboard
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
            Top funded traders ranked by profit percentage · Click a trader to view their profile
          </p>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px', color: 'var(--text-muted)' }}>Loading...</div>
        ) : leaders.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '64px' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              {renderIcon('analytics', { size: 40, color: 'var(--accent)' })}
            </div>
            <p style={{ color: 'var(--text-muted)' }}>No funded traders yet. Be the first!</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {leaders.map((row, idx) => (
              <div
                key={idx}
                className="card"
                onClick={() => navigate(`/trader/${row.user_id}`)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '20px',
                  padding: '20px 24px',
                  borderLeft: `3px solid ${idx === 0 ? 'var(--rule)' : idx === 1 ? 'var(--rule)' : idx === 2 ? 'var(--rule)' : 'var(--navy-border)'}`,
                  background: idx === 0 ? 'rgba(157, 157, 157, 0.04)' : 'var(--navy-card)',
                  cursor: 'pointer',
                  transition: 'background 0.15s'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(148, 148, 148, 0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = idx === 0 ? 'rgba(157, 157, 157, 0.04)' : 'var(--navy-card)'}
              >
                {/* Rank */}
                <div style={{ minWidth: '36px', textAlign: 'center', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px' }}>
                  {idx < 3 ? (
                    <>
                      {renderIcon('leaderboard', { size: 18, color: idx === 0 ? 'var(--accent-gold)' : 'var(--text-secondary)' })}
                      <span style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: '700' }}>{idx + 1}</span>
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-dim)', fontSize: '14px', fontWeight: '700' }}>#{idx + 1}</span>
                  )}
                </div>

                {/* Name & Country */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: '700', fontSize: '15px', color: 'var(--accent)', marginBottom: '3px' }}>
                    {row.full_name}
                    <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: '400', marginLeft: '8px' }}>View Profile →</span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                    {row.country || 'Unknown'} · ${parseFloat(row.account_size).toLocaleString('en-US')} account
                  </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
                    Trader ID: {row.trader_uid || '—'} · Account ID: {row.account_uid || '—'}
                  </div>
                </div>

                {/* Profit % */}
                <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '20px', fontWeight: '800', color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                    +{parseFloat(row.profit_pct).toFixed(2)}%
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                    +${parseFloat(row.profit_usd).toFixed(2)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ textAlign: 'center', marginTop: '40px', marginBottom: '40px' }}>
          <p style={{ color: 'var(--text-dim)', fontSize: '12px' }}>
            Rankings update in real-time · Shows top 20 active funded accounts
          </p>
        </div>
        </div>
      </div>
    </PageWrapper>
  )
}
