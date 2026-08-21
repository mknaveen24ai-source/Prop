import React, { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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
      <div style={{ textAlign: 'center', marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-3)' }}>
          {renderIcon('leaderboard', { size: 48, color: 'var(--accent)' })}
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)', fontSize: 'var(--fs-5xl)', marginBottom: 'var(--space-2)' }}>
          Trading Competitions
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-md)' }}>
          Join a weekly or monthly contest, trade a dedicated account, and climb the leaderboard
        </p>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '80px', color: 'var(--muted)' }}>Loading...</div>
      ) : loadError ? (
        <Card style={{ textAlign: 'center', padding: 'var(--space-10)', border: '1px solid var(--warn)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
            {renderIcon('warning', { size: 40, color: 'var(--warn)' })}
          </div>
          <p style={{ color: 'var(--warn)', marginBottom: 'var(--space-3)' }}>Couldn't load competitions right now.</p>
          <button onClick={() => window.location.reload()} className="lx-btn" style={{ padding: 'var(--space-2) var(--space-4)', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)' }}>
            Retry
          </button>
        </Card>
      ) : competitions.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 'var(--space-10)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
            {renderIcon('analytics', { size: 40, color: 'var(--accent)' })}
          </div>
          <p style={{ color: 'var(--muted)' }}>No competitions scheduled right now. Check back soon!</p>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2-5)' }}>
          {competitions.map((c) => (
            <Card
              key={c.slug}
              interactive
              onClick={() => openCompetition(c.slug)}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', padding: 'var(--space-5) var(--space-6)' }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)', marginBottom: 'var(--space-1-5)' }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-lg)', color: 'var(--ink)' }}>{c.title}</span>
                  {statusBadge(c.status)}
                </div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                  {formatDate(c.start_at)} → {formatDate(c.end_at)} · ${c.starting_balance.toLocaleString('en-US')} account
                  {c.entry_fee > 0 ? ` · $${c.entry_fee} entry` : ' · Free entry'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 'var(--fs-xl)', fontFamily: 'var(--font-mono)', color: 'var(--ink)' }}>
                  {c.participant_count ?? 0}{c.max_participants ? ` / ${c.max_participants}` : ''}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>participants</div>
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

  return (
    <PageWrapper>
      <div style={{ minHeight: '100dvh', background: 'var(--paper)' }}>
        <div className="nav">
          <Link className="nav-logo" to="/" style={{ cursor: 'pointer', textDecoration: 'none', color: 'inherit' }}>PROP FIRM</Link>
          <ThemeToggle />
        </div>

        <div style={{ maxWidth: '800px', margin: '48px auto 0', padding: '0 var(--space-6)' }}>
          <CompetitionsListContent />
        </div>
      </div>
    </PageWrapper>
  )
}
