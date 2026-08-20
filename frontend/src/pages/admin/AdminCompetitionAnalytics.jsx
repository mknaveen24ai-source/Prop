import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext, useParams, useNavigate } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import Card from '../../components/ui/Card'

function StatCard({ label, value }) {
  return (
    <Card stat>
      <div style={{ fontSize: 'var(--fs-xs)', opacity: 0.7, marginBottom: 'var(--space-1-5)' }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700 }}>{value}</div>
    </Card>
  )
}

const SORT_OPTIONS = [
  { key: 'realized_pnl', label: 'Realized P&L' },
  { key: 'win_rate', label: 'Win Rate' },
  { key: 'profit_factor', label: 'Profit Factor' },
  { key: 'total_trades', label: 'Total Trades' }
]

export default function AdminCompetitionAnalytics() {
  const { adminAxios } = useOutletContext()
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState('realized_pnl')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get(`/api/admin/competitions/${id}/analytics`)
      setData(res.data)
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not load competition analytics')
    } finally {
      setLoading(false)
    }
  }, [adminAxios, id, toast])

  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ padding: 'var(--space-7)', opacity: 0.7 }}>Loading analytics...</div>
  if (!data) return <div style={{ padding: 'var(--space-7)', opacity: 0.7 }}>No data available</div>

  const { summary, entries } = data
  const sortedEntries = [...entries].sort((a, b) => b[sortKey] - a[sortKey])

  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <button className="admin-btn admin-btn-sm" style={{ marginBottom: 'var(--space-4)' }} onClick={() => navigate(`/admin/competitions/${id}`)}>
        ← Back to Competition
      </button>

      <h2 style={{ margin: '0 0 4px' }}>Trade Analytics</h2>
      <p style={{ margin: '0 0 20px', opacity: 0.7, fontSize: 'var(--fs-base)' }}>
        Participant trading performance for this competition's window only.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3-5)', marginBottom: 'var(--space-6)' }}>
        <StatCard label="Participants" value={summary.participant_count} />
        <StatCard label="Total Trades" value={summary.total_trades} />
        <StatCard label="Overall Win Rate" value={`${summary.overall_win_rate}%`} />
        <StatCard label="Total Realized P&L" value={`$${summary.total_realized_pnl.toFixed(2)}`} />
        <StatCard label="Most Active Trader" value={summary.most_active_trader || '—'} />
      </div>

      <Card style={{ padding: 'var(--space-5)', overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)', marginBottom: 'var(--space-3)' }}>
          <span style={{ fontSize: 'var(--fs-sm)', opacity: 0.7 }}>Sort by:</span>
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              className="admin-btn admin-btn-sm"
              style={{ opacity: sortKey === opt.key ? 1 : 0.6 }}
              onClick={() => setSortKey(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-base)' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.7 }}>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Trader</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Trades</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Win Rate</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Profit Factor</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Avg Win</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Avg Loss</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Best Trade</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Worst Trade</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Realized P&L</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((e) => (
              <tr key={e.entry_id} style={{ borderTop: '1px solid var(--admin-border)' }}>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>{e.full_name}<div style={{ fontSize: 'var(--fs-xs)', opacity: 0.6 }}>{e.email}</div></td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>{e.total_trades} <span style={{ opacity: 0.6 }}>({e.winning_trades}W/{e.losing_trades}L)</span></td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>{e.win_rate}%</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>{e.profit_factor}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>${e.avg_win.toFixed(2)}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>${e.avg_loss.toFixed(2)}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>${e.best_trade.toFixed(2)}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>${e.worst_trade.toFixed(2)}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)', fontWeight: 700, color: e.realized_pnl >= 0 ? 'var(--admin-success)' : 'var(--admin-danger, #d33)' }}>
                  ${e.realized_pnl.toFixed(2)}
                </td>
              </tr>
            ))}
            {sortedEntries.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 'var(--space-5)', textAlign: 'center', opacity: 0.6 }}>No entries yet</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
