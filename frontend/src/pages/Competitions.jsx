import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import ThemeToggle from '../components/ThemeToggle'
import { PageWrapper } from '../App'
import { renderIcon } from '../utils/iconMap'

function statusBadge(status) {
  const map = {
    upcoming: { label: 'Upcoming', color: 'var(--text-secondary)' },
    active: { label: 'Live', color: 'var(--green)' },
    completed: { label: 'Completed', color: 'var(--text-dim)' },
    cancelled: { label: 'Cancelled', color: 'var(--text-dim)' }
  }
  const info = map[status] || map.upcoming
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 'var(--radius-pill)',
      fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      color: info.color, border: `1px solid ${info.color}`, background: `color-mix(in srgb, ${info.color} 15%, transparent)`
    }}>
      {info.label}
    </span>
  )
}

function formatDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// Pure content — no page chrome, so it can be embedded inside the dashboard
// (DashboardCompetitionsPage.jsx) as well as rendered standalone below.
export function CompetitionsListContent({ onSelectSlug }) {
  const [competitions, setCompetitions] = useState([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    api.get('/api/competitions')
      .then(res => setCompetitions(Array.isArray(res.data) ? res.data : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  function openCompetition(slug) {
    if (onSelectSlug) onSelectSlug(slug)
    else navigate(`/competitions/${slug}`)
  }

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: '40px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
          {renderIcon('leaderboard', { size: 48, color: 'var(--accent-gold)' })}
        </div>
        <h1 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', fontSize: '28px', marginBottom: '8px' }}>
          Trading Competitions
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          Join a weekly or monthly contest, trade a dedicated account, and climb the leaderboard
        </p>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '80px', color: 'var(--text-muted)' }}>Loading...</div>
      ) : competitions.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '64px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('analytics', { size: 40, color: 'var(--accent)' })}
          </div>
          <p style={{ color: 'var(--text-muted)' }}>No competitions scheduled right now. Check back soon!</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {competitions.map((c) => (
            <div
              key={c.slug}
              className="card"
              onClick={() => openCompetition(c.slug)}
              style={{
                display: 'flex', alignItems: 'center', gap: '20px',
                padding: '20px 24px', cursor: 'pointer', transition: 'background 0.15s'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'color-mix(in srgb, var(--muted) 6%, transparent)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--navy-card)'}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--accent)' }}>{c.title}</span>
                  {statusBadge(c.status)}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                  {formatDate(c.start_at)} → {formatDate(c.end_at)} · ${c.starting_balance.toLocaleString('en-US')} account
                  {c.entry_fee > 0 ? ` · $${c.entry_fee} entry` : ' · Free entry'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                  {c.participant_count ?? 0}{c.max_participants ? ` / ${c.max_participants}` : ''}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>participants</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Standalone full page — used for the public/direct-URL route.
export default function Competitions() {
  const navigate = useNavigate()

  return (
    <PageWrapper>
      <div style={{ minHeight: '100vh', background: 'var(--navy)' }}>
        <div className="nav">
          <span className="nav-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>PROP FIRM</span>
          <ThemeToggle />
        </div>

        <div style={{ maxWidth: '800px', margin: '48px auto 0', padding: '0 24px' }}>
          <CompetitionsListContent />
        </div>
      </div>
    </PageWrapper>
  )
}
