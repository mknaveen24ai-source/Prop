import React, { useState, useEffect, useCallback } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { PieChart, Pie, Cell } from 'recharts'
import api from '../services/api'
import ThemeToggle from '../components/ThemeToggle'
import { PageWrapper } from '../App'
import { useAuth } from '../providers/AuthProvider'
import Card from '../components/ui/Card'
import Sparkline from '../components/ui/Sparkline'
import { renderActiveDonutArc, dimUnlessActive } from '../components/admin/AdminChart'
import Pagination from '../components/Pagination'
import { renderIcon } from '../utils/iconMap'
import { exportRowsToCSV } from '../utils/exportCsv'

const LEADERBOARD_POLL_MS = 15000
const STANDINGS_PAGE_SIZE = 20

const STANDINGS_EXPORT_COLUMNS = [
  { header: 'Rank', value: (r) => r.rank },
  { header: 'Trader', value: (r) => r.full_name },
  { header: 'Country', value: (r) => r.country || '' },
  { header: 'Return %', value: (r) => r.profit_pct.toFixed(2) },
  { header: 'P&L', value: (r) => r.profit_usd.toFixed(2) },
  { header: 'Status', value: (r) => r.status || '' },
]
const PODIUM_TONES = ['var(--accent)', 'var(--ink)', 'var(--warn)']
const PRIZE_TONES = ['var(--accent)', 'var(--gain)', 'var(--warn)', 'var(--muted)', 'var(--loss)']

const STATUS_LABELS = { upcoming: 'Upcoming', active: 'Live now', completed: 'Completed', cancelled: 'Cancelled' }
const TYPE_LABELS = { weekly: 'Weekly Competition', monthly: 'Monthly Competition', custom: 'Competition' }

function formatDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function formatTime(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// Parses a leading dollar figure out of a free-text prize label ("$500",
// "$1,200 cash") for the donut's proportional sizing — prize_pool_json is
// informational display text, not guaranteed numeric (e.g. "Free $50k
// challenge account voucher"), so this can legitimately come back null.
function parsePrizeAmount(label) {
  const match = String(label || '').match(/\$\s?([\d,]+(?:\.\d+)?)/)
  return match ? parseFloat(match[1].replace(/,/g, '')) : null
}

function timeStatusLabel(competition) {
  const now = Date.now()
  if (competition.status === 'upcoming') {
    const days = Math.max(0, Math.ceil((new Date(competition.start_at) - now) / 86400000))
    return days > 0 ? `Starts in ${days}d` : 'Starting soon'
  }
  if (competition.status === 'active') {
    const days = Math.max(0, Math.ceil((new Date(competition.end_at) - now) / 86400000))
    return days > 0 ? `${days}d left` : 'Ending today'
  }
  return `Ended ${formatDate(competition.end_at)}`
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
  const [lastUpdated, setLastUpdated] = useState(null)
  const [showTerms, setShowTerms] = useState(false)
  const [hoveredPrize, setHoveredPrize] = useState(null)
  const [standingsPage, setStandingsPage] = useState(1)

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
      setLastUpdated(new Date())
    } catch {
      // keep last known leaderboard on transient failure
    }
  }, [slug])

  useEffect(() => { loadCompetition() }, [loadCompetition])
  useEffect(() => { setStandingsPage(1) }, [slug])
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
    return <div style={{ textAlign: 'center', padding: 'var(--space-11)', color: 'var(--muted)' }}>Loading...</div>
  }

  if (!competition) {
    return <div style={{ textAlign: 'center', padding: 'var(--space-11)', color: 'var(--muted)' }}>Competition not found.</div>
  }

  const myEntry = competition.my_entry
  const canJoin = ['upcoming', 'active'].includes(competition.status) && !myEntry
  const prizePool = Array.isArray(competition.prize_pool) ? competition.prize_pool : []
  const prizeAmounts = prizePool.map((p) => parsePrizeAmount(p.label))
  const allPrizesNumeric = prizeAmounts.length > 0 && prizeAmounts.every((a) => a != null)
  const prizeTotal = allPrizesNumeric ? prizeAmounts.reduce((a, b) => a + b, 0) : null
  const podium = leaders.slice(0, 3)
  const standingsTotalPages = Math.max(1, Math.ceil(leaders.length / STANDINGS_PAGE_SIZE))
  const pagedLeaders = leaders.slice((standingsPage - 1) * STANDINGS_PAGE_SIZE, standingsPage * STANDINGS_PAGE_SIZE)

  const compStats = [
    { label: 'Entry', value: competition.entry_fee > 0 ? `$${competition.entry_fee}` : 'Free', tone: 'var(--accent)' },
    { label: 'Participants', value: `${competition.participant_count ?? 0}${competition.max_participants ? ` / ${competition.max_participants}` : ''}`, tone: 'var(--gain)' },
    { label: 'Max Drawdown', value: `${competition.max_drawdown_pct}%`, tone: 'var(--warn)' },
    { label: 'Status', value: timeStatusLabel(competition), tone: 'var(--muted)' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4-5)' }}>
      <button
        onClick={goBack}
        style={{
          background: 'none', border: 'none', color: 'var(--muted)', fontSize: 'var(--fs-base)',
          fontFamily: 'var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase',
          cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)'
        }}
      >
        ← Back to Competitions
      </button>

      {/* Hero + Prize Pool — Modern Gazette handoff spec, isComps block */}
      <div className="ui-split" style={{ alignItems: 'stretch', '--split': 'minmax(0,1.4fr) minmax(0,1fr)' }}>
        <div style={{ position: 'relative', overflow: 'hidden', background: 'var(--glass-2)', backdropFilter: 'blur(18px) saturate(150%)', border: '1px solid var(--accent)', borderRadius: '4px', boxShadow: 'var(--elev-lg)', padding: 'var(--space-6) var(--space-6)' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(420px 220px at 88% 0%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 70%)', pointerEvents: 'none' }} />
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--accent)' }}>
            {TYPE_LABELS[competition.type] || 'Competition'} · {STATUS_LABELS[competition.status] || competition.status}
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-6xl)', lineHeight: 1.08, marginTop: 'var(--space-2)', letterSpacing: '-.015em' }}>{competition.title}</div>
          {competition.description && (
            <div style={{ fontSize: 'var(--fs-md)', color: 'var(--muted)', marginTop: 'var(--space-2-5)', maxWidth: '52ch' }}>{competition.description}</div>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-6)', marginTop: 'var(--space-5)', flexWrap: 'wrap' }}>
            {compStats.map((c) => (
              <div key={c.label}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>{c.label}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xl)', marginTop: 'var(--space-1)', color: c.tone }}>{c.value}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2-5)', marginTop: 'var(--space-6)', flexWrap: 'wrap' }}>
            {myEntry ? (
              <div style={{ padding: 'var(--space-3) var(--space-4-5)', border: '1px solid var(--rule)', borderRadius: '4px', fontSize: 'var(--fs-base)', color: 'var(--ink)' }}>
                You're entered — status: <strong>{myEntry.status}</strong>{myEntry.final_rank && ` · finished #${myEntry.final_rank}`}
              </div>
            ) : canJoin ? (
              <button
                disabled={joining}
                onClick={handleJoin}
                style={{ padding: 'var(--space-3) var(--space-6)', border: '1px solid var(--accent)', borderRadius: '4px', background: 'var(--accent)', color: 'var(--paper)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', letterSpacing: '.12em', textTransform: 'uppercase', cursor: joining ? 'default' : 'pointer', opacity: joining ? 0.6 : 1 }}
              >
                {joining ? 'Joining…' : `Enter — ${competition.entry_fee > 0 ? `$${competition.entry_fee}` : 'Free'}`}
              </button>
            ) : (
              <div style={{ padding: 'var(--space-3) var(--space-4-5)', border: '1px solid var(--rule)', borderRadius: '4px', fontSize: 'var(--fs-base)', color: 'var(--muted)' }}>
                {competition.status === 'completed' || competition.status === 'cancelled' ? `This competition is ${competition.status}.` : 'Not accepting entries right now.'}
              </div>
            )}
            <button
              onClick={() => setShowTerms((v) => !v)}
              style={{ padding: 'var(--space-3) var(--space-5)', border: '1px solid var(--rule)', borderRadius: '4px', background: 'transparent', color: 'var(--ink)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', letterSpacing: '.12em', textTransform: 'uppercase', cursor: 'pointer' }}
            >
              {showTerms ? 'Hide the terms' : 'Read the terms'}
            </button>
          </div>
        </div>

        {prizePool.length > 0 && (
          <Card title="Prize Pool">
            <div style={{ padding: '0 var(--space-2)', display: 'flex', justifyContent: 'center' }}>
              <PieChart width={180} height={140}>
                <Pie
                  data={prizePool}
                  dataKey={(p) => (allPrizesNumeric ? parsePrizeAmount(p.label) : 1)}
                  nameKey="rank"
                  innerRadius={40}
                  outerRadius={60}
                  activeIndex={hoveredPrize}
                  activeShape={renderActiveDonutArc}
                  onMouseEnter={(_, idx) => setHoveredPrize(idx)}
                  onMouseLeave={() => setHoveredPrize(null)}
                >
                  {prizePool.map((p, idx) => (
                    <Cell key={p.rank} fill={PRIZE_TONES[idx % PRIZE_TONES.length]} fillOpacity={dimUnlessActive(hoveredPrize, idx)} />
                  ))}
                </Pie>
              </PieChart>
            </div>
            {hoveredPrize != null && prizePool[hoveredPrize] && (
              <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--ink)', marginTop: '-var(--space-2)', marginBottom: 'var(--space-2)' }}>
                #{prizePool[hoveredPrize].rank} · {prizePool[hoveredPrize].label}
              </div>
            )}
            {prizeTotal != null && hoveredPrize == null && (
              <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-base)', color: 'var(--muted)', marginTop: '-var(--space-2)', marginBottom: 'var(--space-2)' }}>
                ${prizeTotal.toLocaleString('en-US')} total
              </div>
            )}
            {prizePool.map((p, idx) => (
              <div key={p.rank} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--rule-soft)' }}>
                <span style={{ width: '9px', height: '9px', background: PRIZE_TONES[idx % PRIZE_TONES.length], flex: '0 0 auto' }} />
                <span style={{ flex: 1, fontSize: 'var(--fs-base)' }}>#{p.rank} place</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-base)' }}>{p.label}</span>
              </div>
            ))}
          </Card>
        )}
      </div>

      {showTerms && (
        <Card ruled title="Rules & Terms">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 'var(--space-3-5)', fontSize: 'var(--fs-base)' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>Starting Balance</div>
              <div style={{ marginTop: 'var(--space-1)' }}>${competition.starting_balance.toLocaleString('en-US')}</div>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>Ranking Metric</div>
              <div style={{ marginTop: 'var(--space-1)' }}>{competition.ranking_metric === 'profit_usd' ? 'Realized P&L ($)' : 'Return (%)'}</div>
            </div>
            {competition.daily_drawdown_pct != null && (
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>Daily Drawdown Limit</div>
                <div style={{ marginTop: 'var(--space-1)' }}>{competition.daily_drawdown_pct}%</div>
              </div>
            )}
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>Window</div>
              <div style={{ marginTop: 'var(--space-1)' }}>{formatDate(competition.start_at)} → {formatDate(competition.end_at)}</div>
            </div>
          </div>
          {competition.rules && Object.keys(competition.rules).length > 0 && (
            <pre style={{ marginTop: 'var(--space-3-5)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--muted)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
              {JSON.stringify(competition.rules, null, 2)}
            </pre>
          )}
        </Card>
      )}

      {myVoucher && (
        <Card style={{ border: '1px solid var(--accent)' }}>
          <div style={{ fontSize: 'var(--fs-lg)', color: 'var(--accent)', marginBottom: 'var(--space-1-5)' }}>
            You won a free ${Number(myVoucher.account_size).toLocaleString('en-US')} challenge account
          </div>
          <div style={{ fontSize: 'var(--fs-base)', color: 'var(--muted)', marginBottom: 'var(--space-3)' }}>
            Redeem your prize before it expires{myVoucher.expires_at ? ` on ${formatDate(myVoucher.expires_at)}` : ''}.
          </div>
          <button className="lx-btn lx-btn--md lx-btn--primary" onClick={() => navigate(`/checkout?voucher=${myVoucher.code}`)}>
            Claim Your Prize
          </button>
        </Card>
      )}

      {/* Podium */}
      {podium.length > 0 && (
        <div className="ui-cols" style={{ '--cols': 'repeat(3,minmax(0,1fr))', '--cols-gap': '14px' }}>
          {podium.map((p, idx) => (
            <Card key={p.entry_id} interactive onClick={() => (onSelectTrader ? onSelectTrader(p.user_id) : navigate(`/trader/${p.user_id}`))}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-6xl)', lineHeight: 1, color: PODIUM_TONES[idx], minWidth: '44px' }}>{p.rank}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 'var(--fs-lg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.full_name}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: 'var(--space-1)' }}>
                    {p.country || 'Unknown'} · {p.days_traded != null ? `${p.days_traded}d traded` : '—'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Return</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-4xl)', color: p.profit_pct >= 0 ? 'var(--gain)' : 'var(--loss)', marginTop: 'var(--space-1)' }}>
                    {p.profit_pct >= 0 ? '+' : ''}{p.profit_pct.toFixed(2)}%
                  </div>
                </div>
                <div style={{ width: '96px', height: '34px' }}>
                  <Sparkline data={p.spark} tone={p.profit_pct >= 0 ? 'var(--gain)' : 'var(--loss)'} width={96} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Standings */}
      <Card ruled flush title="Standings" actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--muted)' }}>Updated {lastUpdated ? formatTime(lastUpdated) : '—'}</span>
          {leaders.length > 0 && (
            <button
              onClick={() => exportRowsToCSV(leaders, STANDINGS_EXPORT_COLUMNS, `${slug}_standings_${new Date().toISOString().slice(0, 10)}.csv`)}
              className="lx-btn"
              style={{ padding: 'var(--space-1-5) var(--space-2-5)', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)' }}
            >
              {renderIcon('download', { size: 12 })} Export
            </button>
          )}
        </div>
      }>
        {leaders.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-9)', color: 'var(--muted)' }}>No entries yet. Be the first to join!</div>
        ) : (
          <>
            {/* Scroller, not decoration: .lx-table has a min-width floor below
                md and overflows the document without one. */}
            <div className="lx-table-wrap">
            <table className="lx-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Trader</th>
                  <th>Country</th>
                  <th>Return</th>
                  <th>P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {pagedLeaders.map((row) => (
                  <tr
                    key={row.entry_id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => (onSelectTrader ? onSelectTrader(row.user_id) : navigate(`/trader/${row.user_id}`))}
                  >
                    <td style={{ fontFamily: 'var(--font-mono)' }}>#{row.rank}</td>
                    <td>
                      {row.full_name}
                      {row.status === 'disqualified' && (
                        <span className="lx-badge" style={{ color: 'var(--loss)', marginLeft: 'var(--space-2)' }}>Disqualified</span>
                      )}
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{row.country || 'Unknown'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', color: row.profit_pct >= 0 ? 'var(--gain)' : 'var(--loss)' }}>
                      {row.profit_pct >= 0 ? '+' : ''}{row.profit_pct.toFixed(2)}%
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', color: row.profit_usd >= 0 ? 'var(--gain)' : 'var(--loss)' }}>
                      {row.profit_usd >= 0 ? '+' : ''}${row.profit_usd.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div style={{ padding: 'var(--space-2-5) var(--space-4-5)' }}>
              <Pagination page={standingsPage} totalPages={standingsTotalPages} onPageChange={setStandingsPage} pageSize={STANDINGS_PAGE_SIZE} total={leaders.length} />
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

// Standalone full page — used for the public/direct-URL route.
export default function CompetitionDetail() {
  const { slug } = useParams()

  return (
    <PageWrapper>
      <div style={{ minHeight: '100dvh', background: 'var(--paper)' }}>
        <div className="nav">
          <Link className="nav-logo" to="/competitions" style={{ cursor: 'pointer', textDecoration: 'none', color: 'inherit' }}>PROP FIRM</Link>
          <ThemeToggle />
        </div>

        <div style={{ maxWidth: '1040px', margin: 'var(--space-9) auto 0', padding: '0 var(--space-6) var(--space-9)' }}>
          <CompetitionDetailContent slug={slug} />
        </div>
      </div>
    </PageWrapper>
  )
}
