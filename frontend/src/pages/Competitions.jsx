import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import ThemeToggle from '../components/ThemeToggle'
import { PageWrapper } from '../App'
import { renderIcon } from '../utils/iconMap'
import Card from '../components/ui/Card'
import { getStatusToneColor } from '../utils/statusTone'

const STATUS_LABELS = { upcoming: 'Upcoming', active: 'Live', completed: 'Completed', cancelled: 'Cancelled' }

function statusBadge(status) {
  const color = getStatusToneColor(status)
  return (
    <span className="lx-badge" style={{ color }}>
      {STATUS_LABELS[status] || status}
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
  const [loadError, setLoadError] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    api.get('/api/competitions')
      .then(res => { setCompetitions(Array.isArray(res.data) ? res.data : []); setLoadError(false) })
      .catch(() => setLoadError(true))
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
          {renderIcon('leaderboard', { size: 48, color: 'var(--accent)' })}
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)', fontSize: '28px', marginBottom: '8px' }}>
          Trading Competitions
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: '14px' }}>
          Join a weekly or monthly contest, trade a dedicated account, and climb the leaderboard
        </p>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '80px', color: 'var(--muted)' }}>Loading...</div>
      ) : loadError ? (
        <Card style={{ textAlign: 'center', padding: '64px', border: '1px solid var(--warn)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('warning', { size: 40, color: 'var(--warn)' })}
          </div>
          <p style={{ color: 'var(--warn)', marginBottom: '12px' }}>Couldn't load competitions right now.</p>
          <button onClick={() => window.location.reload()} className="lx-btn" style={{ padding: '8px 16px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)' }}>
            Retry
          </button>
        </Card>
      ) : competitions.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: '64px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('analytics', { size: 40, color: 'var(--accent)' })}
          </div>
          <p style={{ color: 'var(--muted)' }}>No competitions scheduled right now. Check back soon!</p>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {competitions.map((c) => (
            <Card
              key={c.slug}
              interactive
              onClick={() => openCompetition(c.slug)}
              style={{ display: 'flex', alignItems: 'center', gap: '20px', padding: '20px 24px' }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: '16px', color: 'var(--ink)' }}>{c.title}</span>
                  {statusBadge(c.status)}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                  {formatDate(c.start_at)} → {formatDate(c.end_at)} · ${c.starting_balance.toLocaleString('en-US')} account
                  {c.entry_fee > 0 ? ` · $${c.entry_fee} entry` : ' · Free entry'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '18px', fontFamily: 'var(--font-mono)', color: 'var(--ink)' }}>
                  {c.participant_count ?? 0}{c.max_participants ? ` / ${c.max_participants}` : ''}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--muted)' }}>participants</div>
              </div>
            </Card>
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
      <div style={{ minHeight: '100dvh', background: 'var(--paper)' }}>
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
