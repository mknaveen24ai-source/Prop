import React, { useState, useEffect } from 'react'
import axios from 'axios'

function Admin() {
  const [token, setToken] = useState(localStorage.getItem('adminToken'))
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('overview')
  const [overview, setOverview] = useState(null)
  const [traders, setTraders] = useState([])
  const [accounts, setAccounts] = useState([])
  const [payouts, setPayouts] = useState([])
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState('')

  const headers = { Authorization: `Bearer ${token}` }

  useEffect(() => {
    if (token) {
      fetchOverview()
      fetchTraders()
      fetchAccounts()
      fetchPayouts()
      const interval = setInterval(fetchOverview, 10000)
      return () => clearInterval(interval)
    }
  }, [token])

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await axios.post('http://localhost:5000/api/admin/login', { password })
      localStorage.setItem('adminToken', res.data.token)
      setToken(res.data.token)
    } catch (err) {
      setError('Invalid admin password')
    }
    setLoading(false)
  }

  async function fetchOverview() {
    try {
      const res = await axios.get('http://localhost:5000/api/admin/overview', { headers })
      setOverview(res.data)
    } catch (err) {}
  }

  async function fetchTraders() {
    try {
      const res = await axios.get('http://localhost:5000/api/admin/traders', { headers })
      setTraders(res.data)
    } catch (err) {}
  }

  async function fetchAccounts() {
    try {
      const res = await axios.get('http://localhost:5000/api/admin/accounts', { headers })
      setAccounts(res.data)
    } catch (err) {}
  }

  async function fetchPayouts() {
    try {
      const res = await axios.get('http://localhost:5000/api/admin/payouts', { headers })
      setPayouts(res.data)
    } catch (err) {}
  }

  async function approveKyc(userId) {
    try {
      await axios.post('http://localhost:5000/api/admin/kyc/approve', { user_id: userId }, { headers })
      setSuccess('KYC approved')
      fetchTraders()
    } catch (err) {
      setError('Could not approve KYC')
    }
  }

  async function rejectKyc(userId) {
    try {
      await axios.post('http://localhost:5000/api/admin/kyc/reject', { user_id: userId }, { headers })
      setSuccess('KYC rejected')
      fetchTraders()
    } catch (err) {
      setError('Could not reject KYC')
    }
  }

  async function banTrader(userId) {
    try {
      await axios.post('http://localhost:5000/api/admin/ban', { user_id: userId }, { headers })
      setSuccess('Trader banned')
      fetchTraders()
    } catch (err) {
      setError('Could not ban trader')
    }
  }

  async function unbanTrader(userId) {
    try {
      await axios.post('http://localhost:5000/api/admin/unban', { user_id: userId }, { headers })
      setSuccess('Trader unbanned')
      fetchTraders()
    } catch (err) {
      setError('Could not unban trader')
    }
  }

  async function markPaid(payoutId) {
    const txId = prompt('Enter transaction ID:')
    if (!txId) return
    try {
      await axios.post('http://localhost:5000/api/admin/payouts/mark-paid',
        { payout_id: payoutId, transaction_id: txId },
        { headers }
      )
      setSuccess('Payout marked as paid')
      fetchPayouts()
    } catch (err) {
      setError('Could not update payout')
    }
  }

  function handleLogout() {
    localStorage.removeItem('adminToken')
    setToken(null)
  }

  function getStatusColor(status) {
    if (status === 'active') return '#c9a84c'
    if (status === 'passed') return '#1a7a4a'
    if (status === 'failed') return '#c0392b'
    if (status === 'funded') return '#00bcd4'
    if (status === 'expired') return '#888'
    if (status === 'approved') return '#1a7a4a'
    if (status === 'pending') return '#c9a84c'
    if (status === 'rejected') return '#c0392b'
    if (status === 'paid') return '#1a7a4a'
    return '#888'
  }

  if (!token) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="card" style={{ width: '400px' }}>
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <h1 className="gold" style={{ fontSize: '28px' }}>ADMIN PANEL</h1>
            <p style={{ color: '#888', marginTop: '8px' }}>Prop Firm Control Centre</p>
          </div>
          {error && <div className="error">{error}</div>}
          <form onSubmit={handleLogin}>
            <label style={{ fontSize: '12px', color: '#888' }}>ADMIN PASSWORD</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter admin password"
              required
            />
            <button className="btn btn-gold" type="submit" style={{ width: '100%' }} disabled={loading}>
              {loading ? 'Logging in...' : 'Login'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="nav">
        <span className="nav-logo">ADMIN PANEL</span>
        <div style={{ display: 'flex', gap: '12px' }}>
          {['overview', 'traders', 'accounts', 'payouts'].map(tab => (
            <button
              key={tab}
              className="btn"
              onClick={() => setActiveTab(tab)}
              style={{
                background: activeTab === tab ? '#c9a84c' : '#132240',
                color: activeTab === tab ? '#0a1628' : '#fff',
                border: '1px solid #c9a84c',
                padding: '8px 16px',
                textTransform: 'capitalize'
              }}
            >
              {tab}
            </button>
          ))}
          <button className="btn btn-red" onClick={handleLogout} style={{ padding: '8px 16px' }}>
            Logout
          </button>
        </div>
      </div>

      <div className="container" style={{ marginTop: '24px' }}>
        {error && <div className="error" style={{ marginBottom: '16px' }}>{error}</div>}
        {success && <div className="success" style={{ marginBottom: '16px' }}>{success}</div>}

        {activeTab === 'overview' && overview && (
          <div>
            <h2 style={{ marginBottom: '20px', color: '#c9a84c' }}>Overview</h2>
            <div className="grid-4" style={{ marginBottom: '24px' }}>
              <div className="stat-card">
                <div className="stat-value">{overview.users.total_users}</div>
                <div className="stat-label">Total Traders</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ color: '#c0392b' }}>{overview.users.kyc_pending}</div>
                <div className="stat-label">KYC Pending</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ color: '#1a7a4a' }}>{overview.users.kyc_approved}</div>
                <div className="stat-label">KYC Approved</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ color: '#00bcd4' }}>{overview.accounts.funded_active}</div>
                <div className="stat-label">Funded Traders</div>
              </div>
            </div>

            <div className="grid-4" style={{ marginBottom: '24px' }}>
              <div className="stat-card">
                <div className="stat-value">{overview.accounts.phase1_active}</div>
                <div className="stat-label">Phase 1 Active</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{overview.accounts.phase2_active}</div>
                <div className="stat-label">Phase 2 Active</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ color: '#c0392b' }}>{overview.accounts.total_failed}</div>
                <div className="stat-label">Total Failed</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ color: '#888' }}>{overview.accounts.total_expired}</div>
                <div className="stat-label">Total Expired</div>
              </div>
            </div>

            <div className="grid-2">
              <div className="card">
                <h3 style={{ marginBottom: '16px', color: '#c9a84c' }}>Trading Stats</h3>
                <table>
                  <tbody>
                    <tr>
                      <td style={{ color: '#888' }}>Total Open Trades</td>
                      <td>{overview.trading.total_open_trades}</td>
                    </tr>
                    <tr>
                      <td style={{ color: '#888' }}>Total Closed Trades</td>
                      <td>{overview.trading.total_closed_trades}</td>
                    </tr>
                    <tr>
                      <td style={{ color: '#888' }}>Total Demo P&L</td>
                      <td style={{ color: overview.trading.total_demo_pnl >= 0 ? '#1a7a4a' : '#c0392b' }}>
                        ${parseFloat(overview.trading.total_demo_pnl).toFixed(2)}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: '#888' }}>Total Broker P&L</td>
                      <td style={{ color: overview.trading.total_broker_pnl >= 0 ? '#1a7a4a' : '#c0392b' }}>
                        ${parseFloat(overview.trading.total_broker_pnl).toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="card">
                <h3 style={{ marginBottom: '16px', color: '#c9a84c' }}>Payout Stats</h3>
                <table>
                  <tbody>
                    <tr>
                      <td style={{ color: '#888' }}>Pending Payouts</td>
                      <td style={{ color: '#c9a84c' }}>{overview.payouts.pending_payouts}</td>
                    </tr>
                    <tr>
                      <td style={{ color: '#888' }}>Total Paid Out</td>
                      <td style={{ color: '#1a7a4a' }}>${parseFloat(overview.payouts.total_paid_out).toFixed(2)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'traders' && (
          <div>
            <h2 style={{ marginBottom: '20px', color: '#c9a84c' }}>Traders ({traders.length})</h2>
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Country</th>
                    <th>KYC Status</th>
                    <th>Joined</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {traders.map(trader => (
                    <tr key={trader.id}>
                      <td>{trader.full_name}</td>
                      <td>{trader.email}</td>
                      <td>{trader.country}</td>
                      <td>
                        <span style={{ color: getStatusColor(trader.kyc_status) }}>
                          {trader.kyc_status.toUpperCase()}
                        </span>
                      </td>
                      <td>{new Date(trader.created_at).toLocaleDateString()}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          {trader.kyc_status === 'pending' && (
                            <>
                              <button
                                className="btn btn-green"
                                onClick={() => approveKyc(trader.id)}
                                style={{ padding: '4px 10px', fontSize: '12px' }}
                              >
                                Approve
                              </button>
                              <button
                                className="btn btn-red"
                                onClick={() => rejectKyc(trader.id)}
                                style={{ padding: '4px 10px', fontSize: '12px' }}
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {trader.is_banned ? (
                            <button
                              className="btn btn-green"
                              onClick={() => unbanTrader(trader.id)}
                              style={{ padding: '4px 10px', fontSize: '12px' }}
                            >
                              Unban
                            </button>
                          ) : (
                            <button
                              className="btn btn-red"
                              onClick={() => banTrader(trader.id)}
                              style={{ padding: '4px 10px', fontSize: '12px' }}
                            >
                              Ban
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'accounts' && (
          <div>
            <h2 style={{ marginBottom: '20px', color: '#c9a84c' }}>All Accounts ({accounts.length})</h2>
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Trader</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Balance</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Ends</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(acc => (
                    <tr key={acc.id}>
                      <td>{acc.full_name}</td>
                      <td>{acc.account_type.toUpperCase()}</td>
                      <td>${parseFloat(acc.account_size).toLocaleString()}</td>
                      <td>${parseFloat(acc.current_balance).toFixed(2)}</td>
                      <td>
                        <span style={{ color: getStatusColor(acc.status) }}>
                          {acc.status.toUpperCase()}
                        </span>
                      </td>
                      <td>{new Date(acc.phase_start_date).toLocaleDateString()}</td>
                      <td>{acc.phase_end_date ? new Date(acc.phase_end_date).toLocaleDateString() : 'N/A'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'payouts' && (
          <div>
            <h2 style={{ marginBottom: '20px', color: '#c9a84c' }}>Payouts ({payouts.length})</h2>
            <div className="card">
              {payouts.length === 0 ? (
                <p style={{ color: '#888' }}>No payout requests yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Trader</th>
                      <th>Amount</th>
                      <th>Trader Gets</th>
                      <th>Method</th>
                      <th>Status</th>
                      <th>Requested</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map(payout => (
                      <tr key={payout.id}>
                        <td>{payout.full_name}</td>
                        <td>${parseFloat(payout.amount_requested).toFixed(2)}</td>
                        <td>${parseFloat(payout.amount_payable).toFixed(2)}</td>
                        <td>{payout.payment_method}</td>
                        <td>
                          <span style={{ color: getStatusColor(payout.status) }}>
                            {payout.status.toUpperCase()}
                          </span>
                        </td>
                        <td>{new Date(payout.requested_at).toLocaleDateString()}</td>
                        <td>
                          {payout.status === 'approved' && (
                            <button
                              className="btn btn-green"
                              onClick={() => markPaid(payout.id)}
                              style={{ padding: '4px 10px', fontSize: '12px' }}
                            >
                              Mark Paid
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Admin
