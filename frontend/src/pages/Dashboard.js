import React, { useState, useEffect } from 'react'
import axios from 'axios'

function Dashboard({ user, token, onLogout }) {
  const [accounts, setAccounts] = useState([])
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [stats, setStats] = useState(null)
  const [openTrades, setOpenTrades] = useState([])
  const [tradeHistory, setTradeHistory] = useState([])
  const [prices, setPrices] = useState({})
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [orderForm, setOrderForm] = useState({
    instrument: 'EURUSD',
    direction: 'buy',
    lots: '0.01'
  })

  const headers = { Authorization: `Bearer ${token}` }

  useEffect(() => {
    fetchAccounts()
    fetchPrices()
    const priceInterval = setInterval(fetchPrices, 10000)
    return () => clearInterval(priceInterval)
  }, [])

  useEffect(() => {
    if (selectedAccount) {
      fetchStats()
      fetchOpenTrades()
      fetchTradeHistory()
      const interval = setInterval(() => {
        fetchStats()
        fetchOpenTrades()
      }, 5000)
      return () => clearInterval(interval)
    }
  }, [selectedAccount])

  async function fetchAccounts() {
    try {
      const res = await axios.get('http://localhost:5000/api/accounts/my-accounts', { headers })
      setAccounts(res.data)
      if (res.data.length > 0 && !selectedAccount) {
        setSelectedAccount(res.data[0])
      }
    } catch (err) {
      setError('Could not fetch accounts')
    }
  }

  async function fetchPrices() {
    try {
      const res = await axios.get('http://localhost:5000/api/prices')
      setPrices(res.data)
    } catch (err) {}
  }

  async function fetchStats() {
    try {
      const res = await axios.get(
        `http://localhost:5000/api/accounts/stats/${selectedAccount.id}`,
        { headers }
      )
      setStats(res.data)
    } catch (err) {}
  }

  async function fetchOpenTrades() {
    try {
      const res = await axios.get(
        `http://localhost:5000/api/trades/open/${selectedAccount.id}`,
        { headers }
      )
      setOpenTrades(res.data)
    } catch (err) {}
  }

  async function fetchTradeHistory() {
    try {
      const res = await axios.get(
        `http://localhost:5000/api/trades/history/${selectedAccount.id}`,
        { headers }
      )
      setTradeHistory(res.data)
    } catch (err) {}
  }

  async function createAccount(size) {
    try {
      setError('')
      const res = await axios.post(
        'http://localhost:5000/api/accounts/create',
        { account_size: size },
        { headers }
      )
      setSuccess('Account created successfully')
      fetchAccounts()
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create account')
    }
  }

  async function openTrade() {
    try {
      setError('')
      await axios.post(
        'http://localhost:5000/api/trades/open',
        {
          account_id: selectedAccount.id,
          instrument: orderForm.instrument,
          direction: orderForm.direction,
          lots: parseFloat(orderForm.lots)
        },
        { headers }
      )
      setSuccess('Trade opened successfully')
      fetchOpenTrades()
      fetchStats()
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open trade')
    }
  }

  async function closeTrade(tradeId) {
    try {
      setError('')
      const res = await axios.post(
        'http://localhost:5000/api/trades/close',
        { trade_id: tradeId },
        { headers }
      )
      setSuccess(`Trade closed. P&L: $${res.data.pnl}`)
      fetchOpenTrades()
      fetchStats()
      fetchTradeHistory()
    } catch (err) {
      setError(err.response?.data?.error || 'Could not close trade')
    }
  }

  function getStatusColor(status) {
    if (status === 'active') return '#c9a84c'
    if (status === 'passed') return '#1a7a4a'
    if (status === 'failed') return '#c0392b'
    if (status === 'funded') return '#00bcd4'
    return '#888'
  }

  return (
    <div>
      <div className="nav">
        <span className="nav-logo">PROP FIRM</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ color: '#888', fontSize: '14px' }}>
            {user.full_name}
          </span>
          {user.kyc_status !== 'approved' && (
            <span style={{ 
              background: '#c0392b', 
              padding: '4px 10px', 
              borderRadius: '4px', 
              fontSize: '12px' 
            }}>
              KYC Pending
            </span>
          )}
          <button className="btn btn-red" onClick={onLogout} style={{ padding: '8px 16px' }}>
            Logout
          </button>
        </div>
      </div>

      <div className="container" style={{ marginTop: '24px' }}>

        {error && <div className="error" style={{ marginBottom: '16px' }}>{error}</div>}
        {success && <div className="success" style={{ marginBottom: '16px' }}>{success}</div>}

        <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
          {Object.entries(prices).map(([instrument, data]) => (
            <div key={instrument} className="card" style={{ padding: '12px 20px', flex: '1', minWidth: '150px' }}>
              <div style={{ fontSize: '12px', color: '#888' }}>{instrument}</div>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#c9a84c' }}>
                {parseFloat(data.bid).toFixed(instrument.includes('XAU') ? 2 : 5)}
              </div>
            </div>
          ))}
        </div>

        {accounts.length === 0 ? (
          <div className="card">
            <h2 style={{ marginBottom: '16px' }}>Start Your Free Challenge</h2>
            {user.kyc_status !== 'approved' ? (
              <p style={{ color: '#888' }}>Your KYC is pending approval. You will be able to start a challenge once approved.</p>
            ) : (
              <div>
                <p style={{ color: '#888', marginBottom: '20px' }}>Select your account size to begin:</p>
                <div className="grid-4">
                  {[1000, 2000, 5000, 10000].map(size => (
                    <div key={size} className="stat-card" style={{ cursor: 'pointer' }} onClick={() => createAccount(size)}>
                      <div className="stat-value">${size.toLocaleString()}</div>
                      <div className="stat-label">Click to start</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
              {accounts.map(acc => (
                <button
                  key={acc.id}
                  className="btn"
                  onClick={() => setSelectedAccount(acc)}
                  style={{
                    background: selectedAccount?.id === acc.id ? '#c9a84c' : '#132240',
                    color: selectedAccount?.id === acc.id ? '#0a1628' : '#fff',
                    border: '1px solid #c9a84c'
                  }}
                >
                  {acc.account_type.toUpperCase()} ${parseFloat(acc.account_size).toLocaleString()}
                </button>
              ))}
            </div>

            {stats && (
              <div>
                <div className="grid-4" style={{ marginBottom: '20px' }}>
                  <div className="stat-card">
                    <div className="stat-value">${parseFloat(stats.account.current_balance).toFixed(2)}</div>
                    <div className="stat-label">Current Balance</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value" style={{ color: stats.stats.profit_pct >= 0 ? '#1a7a4a' : '#c0392b' }}>
                      {stats.stats.profit_pct >= 0 ? '+' : ''}{stats.stats.profit_pct}%
                    </div>
                    <div className="stat-label">Profit (Target 10%)</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value" style={{ color: stats.stats.drawdown_pct > 7 ? '#c0392b' : '#c9a84c' }}>
                      -{stats.stats.drawdown_pct}%
                    </div>
                    <div className="stat-label">Drawdown (Max {stats.account.max_drawdown_pct}%)</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{stats.stats.days_remaining}</div>
                    <div className="stat-label">Days Remaining</div>
                  </div>
                </div>

                <div className="card" style={{ marginBottom: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '14px', color: '#888' }}>Profit Progress</span>
                    <span style={{ fontSize: '14px', color: '#c9a84c' }}>{stats.stats.profit_pct}% / 10%</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{
                      width: `${Math.min(Math.max(stats.stats.profit_pct * 10, 0), 100)}%`,
                      background: '#1a7a4a'
                    }} />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', marginTop: '16px' }}>
                    <span style={{ fontSize: '14px', color: '#888' }}>Drawdown Risk</span>
                    <span style={{ fontSize: '14px', color: '#c0392b' }}>{stats.stats.drawdown_pct}% / {stats.account.max_drawdown_pct}%</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{
                      width: `${Math.min((stats.stats.drawdown_pct / stats.account.max_drawdown_pct) * 100, 100)}%`,
                      background: '#c0392b'
                    }} />
                  </div>
                </div>

                {selectedAccount.status === 'active' && (
                  <div className="card" style={{ marginBottom: '20px' }}>
                    <h3 style={{ marginBottom: '16px', color: '#c9a84c' }}>Place Order</h3>
                    <div className="grid-2">
                      <div>
                        <label style={{ fontSize: '12px', color: '#888' }}>INSTRUMENT</label>
                        <select
                          value={orderForm.instrument}
                          onChange={e => setOrderForm({ ...orderForm, instrument: e.target.value })}
                        >
                          <option value="EURUSD">EUR/USD</option>
                          <option value="GBPUSD">GBP/USD</option>
                          <option value="XAUUSD">Gold (XAU/USD)</option>
                          <option value="XAGUSD">Silver (XAG/USD)</option>
                        </select>

                        <label style={{ fontSize: '12px', color: '#888' }}>LOT SIZE</label>
                        <input
                          type="number"
                          value={orderForm.lots}
                          onChange={e => setOrderForm({ ...orderForm, lots: e.target.value })}
                          min="0.01"
                          max="1.00"
                          step="0.01"
                        />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '12px' }}>
                        <button
                          className="btn btn-green"
                          onClick={() => { setOrderForm({ ...orderForm, direction: 'buy' }); openTrade() }}
                          style={{ width: '100%', padding: '16px' }}
                        >
                          BUY {orderForm.instrument}
                        </button>
                        <button
                          className="btn btn-red"
                          onClick={() => { setOrderForm({ ...orderForm, direction: 'sell' }); openTrade() }}
                          style={{ width: '100%', padding: '16px' }}
                        >
                          SELL {orderForm.instrument}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {openTrades.length > 0 && (
                  <div className="card" style={{ marginBottom: '20px' }}>
                    <h3 style={{ marginBottom: '16px', color: '#c9a84c' }}>Open Positions</h3>
                    <table>
                      <thead>
                        <tr>
                          <th>Instrument</th>
                          <th>Direction</th>
                          <th>Lots</th>
                          <th>Open Price</th>
                          <th>Current Price</th>
                          <th>P&L</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {openTrades.map(trade => (
                          <tr key={trade.id}>
                            <td>{trade.instrument}</td>
                            <td style={{ color: trade.direction === 'buy' ? '#1a7a4a' : '#c0392b' }}>
                              {trade.direction.toUpperCase()}
                            </td>
                            <td>{trade.lot_size}</td>
                            <td>{parseFloat(trade.open_price).toFixed(5)}</td>
                            <td>{trade.current_price?.toFixed(5)}</td>
                            <td style={{ color: trade.floating_pnl >= 0 ? '#1a7a4a' : '#c0392b' }}>
                              {trade.floating_pnl >= 0 ? '+' : ''}${trade.floating_pnl}
                            </td>
                            <td>
                              <button
                                className="btn btn-red"
                                onClick={() => closeTrade(trade.id)}
                                style={{ padding: '6px 12px', fontSize: '12px' }}
                              >
                                Close
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {tradeHistory.length > 0 && (
                  <div className="card">
                    <h3 style={{ marginBottom: '16px', color: '#c9a84c' }}>Trade History</h3>
                    <table>
                      <thead>
                        <tr>
                          <th>Instrument</th>
                          <th>Direction</th>
                          <th>Lots</th>
                          <th>Open Price</th>
                          <th>Close Price</th>
                          <th>P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tradeHistory.map(trade => (
                          <tr key={trade.id}>
                            <td>{trade.instrument}</td>
                            <td style={{ color: trade.direction === 'buy' ? '#1a7a4a' : '#c0392b' }}>
                              {trade.direction.toUpperCase()}
                            </td>
                            <td>{trade.lot_size}</td>
                            <td>{parseFloat(trade.open_price).toFixed(5)}</td>
                            <td>{parseFloat(trade.close_price).toFixed(5)}</td>
                            <td style={{ color: trade.demo_pnl >= 0 ? '#1a7a4a' : '#c0392b' }}>
                              {trade.demo_pnl >= 0 ? '+' : ''}${trade.demo_pnl}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default Dashboard
