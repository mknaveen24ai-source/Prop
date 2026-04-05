import React, { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

function formatDuration(mins) {
  if (!mins) return '—'
  if (mins < 60) return `${mins.toFixed(0)}m`
  return `${(mins / 60).toFixed(1)}h`
}

export default function Analytics({ selectedAccount }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const canvasRef = useRef(null)
  const [replayIndex, setReplayIndex] = useState(100)



  // FIX (MEDIUM #17): Use a ref for data to prevent stale closure in ResizeObserver.
  // The observer is created once but drawChart may be called after data changes,
  // causing the observer to capture stale data from the closure.
  const dataRef = useRef(data)
  useEffect(() => {
    dataRef.current = data
  }, [data])

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current
    // Use dataRef.current instead of data from closure
    const currentData = dataRef.current
    if (!canvas || !currentData?.analytics?.drawdown_curve?.length) return

    const ctx = canvas.getContext('2d')
    const fullCurve = currentData.analytics.drawdown_curve
    const curve = fullCurve.slice(0, Math.max(1, Math.floor(fullCurve.length * (replayIndex / 100))))
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light'

    const W = canvas.width = canvas.offsetWidth
    const H = canvas.height = 220
    ctx.clearRect(0, 0, W, H)

    const balances = curve.map(p => p.balance)
    const minBal = Math.min(...balances)
    const maxBal = Math.max(...balances)
    const range = maxBal - minBal || 1

    const pad = { top: 20, right: 20, bottom: 40, left: 70 }
    const chartW = W - pad.left - pad.right
    const chartH = H - pad.top - pad.bottom

    ctx.strokeStyle = isDark ? '#383838' : '#efefef'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (chartH / 4) * i
      ctx.beginPath()
      ctx.moveTo(pad.left, y)
      ctx.lineTo(W - pad.right, y)
      ctx.stroke()
    }

    ctx.fillStyle = isDark ? '#8f8f8f' : '#6f6f6f'
    ctx.font = '11px DM Sans, sans-serif'
    ctx.textAlign = 'right'
    for (let i = 0; i <= 4; i++) {
      const val = maxBal - (range / 4) * i
      const y = pad.top + (chartH / 4) * i
      ctx.fillText('$' + val.toFixed(0), pad.left - 8, y + 4)
    }

    ctx.textAlign = 'center'
    const step = Math.ceil(curve.length / 5)
    curve.forEach((p, i) => {
      if (i % step === 0 || i === curve.length - 1) {
        const x = pad.left + (i / (curve.length - 1)) * chartW
        const y = H - pad.bottom + 16
        const d = new Date(p.date)
        ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, x, y)
      }
    })

    const points = curve.map((p, i) => ({
      x: pad.left + (i / Math.max(curve.length - 1, 1)) * chartW,
      y: pad.top + chartH - ((p.balance - minBal) / range) * chartH
    }))

    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH)
    grad.addColorStop(0, 'rgba(148, 148, 148, 0.3)')
    grad.addColorStop(1, 'rgba(148, 148, 148, 0.02)')
    ctx.beginPath()
    ctx.moveTo(points[0].x, pad.top + chartH)
    points.forEach(p => ctx.lineTo(p.x, p.y))
    ctx.lineTo(points[points.length - 1].x, pad.top + chartH)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    ctx.beginPath()
    ctx.strokeStyle = '#949494'
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
    ctx.stroke()

    points.forEach((p, i) => {
      const pnl = parseFloat(curve[i].balance - (i > 0 ? curve[i - 1].balance : data.account.starting_balance))
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = pnl >= 0 ? '#2ecc71' : '#e74c3c'
      ctx.fill()
    })
  }, [data, replayIndex])

  const fetchAnalytics = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await axios.get(
        `${API_URL}/api/trades/analytics`,
        { params: { account_id: selectedAccount.id } }
      )
      setData(res.data)
    } catch {
      setError('Could not load analytics')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedAccount) fetchAnalytics()
  }, [selectedAccount, fetchAnalytics])

  useEffect(() => {
    if (data?.analytics?.drawdown_curve?.length > 0) {
      drawChart()
      const canvas = canvasRef.current
      if (!canvas) return
      const observer = new ResizeObserver(() => drawChart())
      observer.observe(canvas.parentElement)
      return () => observer.disconnect()
    }
  }, [data, drawChart, replayIndex])

  if (!selectedAccount) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '48px' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>📊</div>
        <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Account Selected</h3>
        <p style={{ color: 'var(--text-muted)' }}>Select an account from the Dashboard to view analytics.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '80px', color: 'var(--text-muted)' }}>
        Loading analytics...
      </div>
    )
  }

  if (error) {
    return <div className="error">{error}</div>
  }

  if (!data) return null

  const { analytics, account } = data

  // Backend returns analytics: null when account has no closed trades yet
  if (!analytics) {
    return (
      <div>
        <h2 style={{ fontFamily: 'Inter, serif', color: 'var(--accent)', marginBottom: '8px', fontSize: '22px' }}>Analytics</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '24px' }}>
          {selectedAccount.account_type.toUpperCase()} — ${parseFloat(selectedAccount.account_size).toLocaleString('en-US')}
        </p>
        <div className="card" style={{ textAlign: 'center', padding: '48px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📭</div>
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Trades Yet</h3>
          <p style={{ color: 'var(--text-muted)' }}>Close some trades to see your analytics.</p>
        </div>
      </div>
    )
  }

  const hasData = analytics.total_trades > 0

  return (
    <div>
      <h2 style={{ fontFamily: 'Inter, serif', color: 'var(--accent)', marginBottom: '8px', fontSize: '22px' }}>
        Analytics
      </h2>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '24px' }}>
        {selectedAccount.account_type.toUpperCase()} — ${parseFloat(selectedAccount.account_size).toLocaleString('en-US')}
      </p>

      {!hasData ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📭</div>
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Trades Yet</h3>
          <p style={{ color: 'var(--text-muted)' }}>Close some trades to see your analytics.</p>
        </div>
      ) : (
        <div>
          {/* Row 1 — Core Stats */}
          <div className="grid-4" style={{ marginBottom: '16px' }}>
            <div className="stat-card">
              <div className="stat-value">{analytics.total_trades}</div>
              <div className="stat-label">Total Trades</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: analytics.win_rate >= 50 ? 'var(--green)' : 'var(--red)' }}>
                {analytics.win_rate}%
              </div>
              <div className="stat-label">Win Rate</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: analytics.total_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {analytics.total_pnl >= 0 ? '+' : ''}${analytics.total_pnl.toFixed(2)}
              </div>
              <div className="stat-label">Total P&L</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: analytics.profit_factor >= 1 ? 'var(--green)' : 'var(--red)' }}>
                {analytics.profit_factor === 999 ? '∞' : analytics.profit_factor}
              </div>
              <div className="stat-label">Profit Factor</div>
            </div>
          </div>

          {/* Row 2 — Trade Quality */}
          <div className="grid-4" style={{ marginBottom: '20px' }}>
            <div className="stat-card">
              <div className="stat-value" style={{ color: 'var(--green)' }}>{analytics.winning_trades}</div>
              <div className="stat-label">Winning Trades</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: 'var(--red)' }}>{analytics.losing_trades}</div>
              <div className="stat-label">Losing Trades</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: 'var(--cyan)' }}>
                {analytics.avg_rr > 0 ? `${analytics.avg_rr}:1` : '—'}
              </div>
              <div className="stat-label">Avg Risk:Reward</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{formatDuration(analytics.avg_trade_duration_mins)}</div>
              <div className="stat-label">Avg Duration</div>
            </div>
          </div>

          {/* Balance Curve Chart */}
          <div className="card" style={{ marginBottom: '20px', padding: '20px' }}>
            <h3 style={{ color: 'var(--accent)', marginBottom: '4px', fontSize: '15px' }}>Balance Curve</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '16px' }}>
              Account balance after each closed trade
            </p>
            <div style={{ position: 'relative', width: '100%' }}>
              <canvas
                ref={canvasRef}
                style={{ width: '100%', height: '220px', display: 'block' }}
              />
              <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Equity Replay</span>
                <input type="range" min="1" max="100" value={replayIndex} onChange={e => { setReplayIndex(Number(e.target.value)); drawChart(); }} style={{ flex: 1, accentColor: 'var(--accent)' }} />
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{replayIndex}%</span>
              </div>
            </div>
          </div>

          {/* Win/Loss Breakdown + Best/Worst */}
          <div className="grid-2" style={{ marginBottom: '20px' }}>
            <div className="card">
              <h3 style={{ color: 'var(--accent)', marginBottom: '16px', fontSize: '15px' }}>Win / Loss Breakdown</h3>

              {/* Win rate bar */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--green)' }}>
                    Wins ({analytics.winning_trades})
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--red)' }}>
                    Losses ({analytics.losing_trades})
                  </span>
                </div>
                <div style={{ height: '12px', borderRadius: '6px', overflow: 'hidden', background: 'var(--navy)', display: 'flex' }}>
                  <div style={{
                    width: `${analytics.win_rate}%`,
                    background: 'var(--green)',
                    transition: 'width 0.5s ease'
                  }} />
                  <div style={{
                    width: `${100 - analytics.win_rate}%`,
                    background: 'var(--red)',
                    transition: 'width 0.5s ease'
                  }} />
                </div>
              </div>

              {[
                { label: 'Avg Winning Trade', value: `+$${analytics.avg_win.toFixed(2)}`, color: 'var(--green)' },
                { label: 'Avg Losing Trade', value: `-$${analytics.avg_loss.toFixed(2)}`, color: 'var(--red)' },
                { label: 'Profit Factor', value: analytics.profit_factor === 999 ? '∞' : analytics.profit_factor, color: analytics.profit_factor >= 1 ? 'var(--green)' : 'var(--red)' },
                { label: 'Expectancy', value: `$${((analytics.win_rate / 100 * analytics.avg_win) - ((1 - analytics.win_rate / 100) * analytics.avg_loss)).toFixed(2)}`, color: 'var(--text)' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--navy-border)' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{row.label}</span>
                  <span style={{ fontSize: '13px', fontWeight: '600', color: row.color, fontFamily: 'DM Mono, monospace' }}>{row.value}</span>
                </div>
              ))}
            </div>

            <div className="card">
              <h3 style={{ color: 'var(--accent)', marginBottom: '16px', fontSize: '15px' }}>Trade Extremes</h3>

              {/* Best trade */}
              <div style={{ background: 'rgba(74, 74, 74, 0.08)', border: '1px solid rgba(74, 74, 74, 0.3)', borderRadius: '8px', padding: '16px', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', color: 'var(--green)', letterSpacing: '0.08em', marginBottom: '6px' }}>🏆 BEST TRADE</div>
                <div style={{ fontSize: '24px', fontWeight: '700', color: 'var(--green)', fontFamily: 'DM Mono, monospace' }}>
                  +${analytics.best_trade.toFixed(2)}
                </div>
              </div>

              {/* Worst trade */}
              <div style={{ background: 'rgba(97, 97, 97, 0.08)', border: '1px solid rgba(97, 97, 97, 0.3)', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
                <div style={{ fontSize: '11px', color: 'var(--red)', letterSpacing: '0.08em', marginBottom: '6px' }}>💥 WORST TRADE</div>
                <div style={{ fontSize: '24px', fontWeight: '700', color: 'var(--red)', fontFamily: 'DM Mono, monospace' }}>
                  ${analytics.worst_trade.toFixed(2)}
                </div>
              </div>

              {[
                { label: 'Avg R:R Ratio', value: analytics.avg_rr > 0 ? `${analytics.avg_rr}:1` : '—', color: 'var(--cyan)' },
                { label: 'Avg Trade Duration', value: formatDuration(analytics.avg_trade_duration_mins), color: 'var(--text)' },
                { label: 'Total Trades', value: analytics.total_trades, color: 'var(--text)' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--navy-border)' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{row.label}</span>
                  <span style={{ fontSize: '13px', fontWeight: '600', color: row.color, fontFamily: 'DM Mono, monospace' }}>{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Profit Heatmap */}
          <div className="card" style={{ marginBottom: '20px' }}>
            <h3 style={{ color: 'var(--accent)', marginBottom: '16px', fontSize: '15px' }}>Profit Heatmap by Time of Day</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(60px, 1fr))', gap: '8px' }}>
              {analytics.heatmap && Object.entries(analytics.heatmap).map(([time, pnl]) => (
                <div key={time} style={{ background: pnl > 0 ? 'rgba(0, 200, 153, 0.15)' : pnl < 0 ? 'rgba(255, 71, 87, 0.15)' : 'var(--navy-card)', padding: '12px', borderRadius: '8px', border: `1px solid ${pnl > 0 ? 'rgba(0, 200, 153, 0.3)' : pnl < 0 ? 'rgba(255, 71, 87, 0.3)' : 'var(--navy-border)'}`, textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>{time}</div>
                  <div style={{ fontSize: '13px', fontWeight: 'bold', color: pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--text-dim)' }}>{pnl >= 0 ? '+' : ''}${pnl}</div>
                </div>
              ))}
            </div>
          </div>
          
          {/* Drawdown Table */}
          {analytics.drawdown_curve.length > 0 && (
            <div className="card">
              <h3 style={{ color: 'var(--accent)', marginBottom: '16px', fontSize: '15px' }}>
                Trade-by-Trade History ({analytics.drawdown_curve.length} trades)
              </h3>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Date</th>
                      <th>Balance</th>
                      <th>P&L</th>
                      <th>Drawdown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.drawdown_curve.map((point, i) => {
                      const prevBal = i === 0
                        ? parseFloat(account.starting_balance)
                        : analytics.drawdown_curve[i - 1].balance
                      const pnl = point.balance - prevBal
                      return (
                        <tr key={i}>
                          <td style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                          <td style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                            {new Date(point.date).toLocaleString()}
                          </td>
                          <td style={{ fontFamily: 'DM Mono, monospace', fontWeight: '600' }}>
                            ${point.balance.toFixed(2)}
                          </td>
                          <td style={{ color: pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: '600', fontFamily: 'DM Mono, monospace' }}>
                            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: 'var(--navy)', overflow: 'hidden', minWidth: '60px' }}>
                                <div style={{
                                  width: `${Math.min(point.drawdown * 10, 100)}%`,
                                  height: '100%',
                                  background: point.drawdown > 5 ? 'var(--red)' : point.drawdown > 2 ? 'var(--accent)' : 'var(--green)',
                                  transition: 'width 0.3s'
                                }} />
                              </div>
                              <span style={{ fontSize: '11px', color: point.drawdown > 5 ? 'var(--red)' : 'var(--text-muted)', fontFamily: 'DM Mono, monospace', minWidth: '36px' }}>
                                {point.drawdown.toFixed(1)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

