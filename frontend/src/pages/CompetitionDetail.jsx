import React, { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import ThemeToggle from '../components/ThemeToggle'
import { PageWrapper } from '../App'
import { renderIcon } from '../utils/iconMap'
import { useAuth } from '../providers/AuthProvider'

const LEADERBOARD_POLL_MS = 15000

function formatDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// Pure content — no page chrome, so it can be embedded inside the dashboard
// (DashboardCompetitionsPage.jsx) as well as rendered standalone below.
export function CompetitionDetailContent({ slug, onBack, onSelectTrader }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [competition, setCompetition] = useState(null)
  const [leaders, setLeaders] = useState([])
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [myVoucher, setMyVoucher] = useState(null)

  const loadCompetition = useCallback(async () => {
    try {
      const res = await api.get(`/api/competitions/${slug}`, { skipAuthRedirect: true })
      setCompetition(res.data)
    } catch {
      setCompetition(null)
    } finally {
      setLoading(false)
    }
  }, [slug])

  const loadLeaderboard = useCallback(async () => {
    try {
      const res = await api.get(`/api/competitions/${slug}/leaderboard`)
      setLeaders(Array.isArray(res.data) ? res.data : [])
    } catch {
      // keep last known leaderboard on transient failure
    }
  }, [slug])

  useEffect(() => { loadCompetition() }, [loadCompetition])
  useEffect(() => {
    loadLeaderboard()
    const interval = setInterval(loadLeaderboard, LEADERBOARD_POLL_MS)
    return () => clearInterval(interval)
  }, [loadLeaderboard])

  useEffect(() => {
    if (!user || competition?.status !== 'completed') return
    api.get('/api/competitions/vouchers/mine')
      .then((res) => {
        const rows = Array.isArray(res.data) ? res.data : []
        const match = rows.find((v) => v.competition_slug === slug && v.status === 'issued')
        setMyVoucher(match || null)
      })
      .catch(() => setMyVoucher(null))
  }, [user, competition, slug])

  async function handleJoin() {
    if (!user) {
      navigate('/login')
      return
    }
    if (user.kyc_status && user.kyc_status !== 'approved') {
      toast.error('Complete KYC verification first before joining a competition.')
      navigate('/dashboard')
      return
    }
    setJoining(true)
    try {
      await api.post(`/api/competitions/${slug}/join`, {}, { skipAuthRedirect: true })
      toast.success('Joined! Your competition account is ready — select it from your account switcher in the dashboard.')
      await loadCompetition()
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not join competition')
    } finally {
      setJoining(false)
    }
  }

  function goBack() {
    if (onBack) onBack()
    else navigate('/competitions')
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '80px', color: 'var(--text-muted)' }}>Loading...</div>
  }

  if (!competition) {
    return <div style={{ textAlign: 'center', padding: '80px', color: 'var(--text-muted)' }}>Competition not found.</div>
  }

  const myEntry = competition.my_entry
  const canJoin = ['upcoming', 'active'].includes(competition.status) && !myEntry

  return (
    <div>
      <button
        onClick={goBack}
        style={{
          background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '13px',
          cursor: 'pointer', padding: 0, marginBottom: '20px', display: 'inline-flex', alignItems: 'center', gap: '6px'
        }}
      >
        ← Back to Competitions
      </button>

      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', fontSize: '26px', marginBottom: '8px' }}>
          {competition.title}
        </h1>
        {competition.description && (
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '12px' }}>{competition.description}</p>
        )}
        <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          {formatDate(competition.start_at)} → {formatDate(competition.end_at)}
        </div>
      </div>

      {/* Rules card */}
      <div className="card" style={{ padding: '20px 24px', marginBottom: '24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>STARTING BALANCE</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>${competition.starting_balance.toLocaleString('en-US')}</div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>MAX DRAWDOWN</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>{competition.max_drawdown_pct}%</div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>ENTRY FEE</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>{competition.entry_fee > 0 ? `$${competition.entry_fee}` : 'Free'}</div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>PARTICIPANTS</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
            {competition.participant_count}{competition.max_participants ? ` / ${competition.max_participants}` : ''}
          </div>
        </div>
      </div>

      {Array.isArray(competition.prize_pool) && competition.prize_pool.length > 0 && (
        <div className="card" style={{ padding: '16px 24px', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '10px' }}>PRIZES</div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            {competition.prize_pool.map((p, idx) => (
              <div key={idx} style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                <strong>#{p.rank}</strong> — {p.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {myVoucher && (
        <div className="card" style={{ padding: '20px 24px', marginBottom: '24px', border: '1px solid var(--accent-gold)' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--accent-gold)', marginBottom: '6px' }}>
            🏆 You won a free ${Number(myVoucher.account_size).toLocaleString('en-US')} challenge account!
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            Redeem your prize before it expires{myVoucher.expires_at ? ` on ${formatDate(myVoucher.expires_at)}` : ''}.
          </div>
          <button className="btn btn-primary" onClick={() => navigate(`/checkout?voucher=${myVoucher.code}`)}>
            Claim Your Prize
          </button>
        </div>
      )}

      {/* Join / status */}
      <div style={{ marginBottom: '32px' }}>
        {myEntry ? (
          <div className="card" style={{ padding: '16px 24px' }}>
            <div style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
              You're entered — status: <strong>{myEntry.status}</strong>
              {myEntry.final_rank && ` · finished #${myEntry.final_rank}`}
            </div>
          </div>
        ) : canJoin ? (
          <button className="btn btn-primary" disabled={joining} onClick={handleJoin} style={{ width: '100%', padding: '14px' }}>
            {joining ? 'Joining...' : 'Join Competition'}
          </button>
        ) : (
          <div className="card" style={{ padding: '16px 24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
            This competition is {competition.status} and no longer accepting entries.
          </div>
        )}
      </div>

      {/* Leaderboard */}
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '18px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          {renderIcon('leaderboard', { size: 20, color: 'var(--accent-gold)' })}
          Leaderboard
        </h2>
      </div>

      {leaders.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
          No entries yet. Be the first to join!
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '40px' }}>
          {leaders.map((row, idx) => (
            <div
              key={row.entry_id}
              className="card"
              onClick={() => (onSelectTrader ? onSelectTrader(row.user_id) : navigate(`/trader/${row.user_id}`))}
              style={{
                display: 'flex', alignItems: 'center', gap: '20px',
                padding: '18px 24px', cursor: 'pointer',
                borderLeft: idx < 3 ? '3px solid var(--rule)' : 'none'
              }}
            >
              <div style={{ minWidth: '32px', textAlign: 'center' }}>
                {idx < 3
                  ? renderIcon('leaderboard', { size: 16, color: idx === 0 ? 'var(--accent-gold)' : 'var(--text-secondary)' })
                  : <span style={{ color: 'var(--text-dim)', fontSize: '13px', fontWeight: 700 }}>#{row.rank}</span>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--accent)' }}>
                  {row.full_name}

                  {row.status === 'disqualified' && <span style={{ color: 'var(--red, #d33)', fontSize: '11px', marginLeft: '8px' }}>DISQUALIFIED</span>}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{row.country || 'Unknown'}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '18px', fontWeight: 800, color: row.profit_pct >= 0 ? 'var(--green)' : 'var(--red, #d33)', fontFamily: 'var(--font-mono)' }}>
                  {row.profit_pct >= 0 ? '+' : ''}{row.profit_pct.toFixed(2)}%
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                  {row.profit_usd >= 0 ? '+' : ''}${row.profit_usd.toFixed(2)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Standalone full page — used for the public/direct-URL route.
export default function CompetitionDetail() {
  const { slug } = useParams()
  const navigate = useNavigate()

  return (
    <PageWrapper>
      <div style={{ minHeight: '100vh', background: 'var(--navy)' }}>
        <div className="nav">
          <span className="nav-logo" onClick={() => navigate('/competitions')} style={{ cursor: 'pointer' }}>PROP FIRM</span>
          <ThemeToggle />
        </div>

        <div style={{ maxWidth: '800px', margin: '48px auto 0', padding: '0 24px' }}>
          <CompetitionDetailContent slug={slug} />
        </div>
      </div>
    </PageWrapper>
  )
}
