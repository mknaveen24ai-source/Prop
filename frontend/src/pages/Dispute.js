import React, { useState, useEffect } from 'react'
import axios from 'axios'

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

const DISPUTE_REASONS = [
  { value: 'drawdown_error',   label: '📊 Drawdown calculation error' },
  { value: 'price_feed',       label: '📡 Incorrect price feed / slippage' },
  { value: 'technical_error',  label: '🔧 Platform technical error' },
  { value: 'wrong_close',      label: '❌ Trade closed incorrectly' },
  { value: 'account_expired',  label: '⏰ Unjust account expiry' },
  { value: 'other',            label: '💬 Other reason' },
]

export default function Dispute({ user, accounts }) {
  const [form, setForm]           = useState({ account_id: '', reason: 'drawdown_error', description: '' })
  const [submitted, setSubmitted] = useState(false)
  const [myDisputes, setMyDisputes] = useState([])
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')

  // Only failed/expired accounts can be disputed
  const eligibleAccounts = (accounts || []).filter(a =>
    ['failed', 'expired'].includes(a.status)
  )

  useEffect(() => {
    fetchMyDisputes()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchMyDisputes() {
    try {
      const res = await axios.get(`${API_URL}/api/disputes/my-disputes`)
      setMyDisputes(res.data || [])
    } catch { setMyDisputes([]) }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!form.account_id) return setError('Please select the account you are disputing.')
    if (form.description.trim().length < 30) return setError('Please describe your issue in at least 30 characters.')
    setLoading(true)
    try {
      await axios.post(`${API_URL}/api/disputes/submit`, {
        account_id:  form.account_id,
        reason:      form.reason,
        description: form.description.trim(),
      })
      setSubmitted(true)
      fetchMyDisputes()
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit dispute. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const statusColors = {
    open:       'var(--accent)',
    under_review: '#858585',
    resolved:   'var(--green)',
    rejected:   'var(--red)',
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Inter, serif', color: 'var(--accent)', marginBottom: '8px', fontSize: '22px' }}>
        Dispute / Appeal
      </h2>
      <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '28px' }}>
        If you believe your account was failed or expired incorrectly, submit a formal dispute below.
        Our team reviews all disputes within 48–72 hours.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '24px', alignItems: 'start' }}>

        {/* ── Dispute Form ── */}
        <div>
          {submitted ? (
            <div className="card" style={{ textAlign: 'center', padding: '48px 32px' }}>
              <div style={{ fontSize: '52px', marginBottom: '16px' }}>📬</div>
              <h3 style={{ color: 'var(--green)', marginBottom: '12px' }}>Dispute Submitted</h3>
              <p style={{ color: 'var(--text-muted)', marginBottom: '24px', lineHeight: '1.7' }}>
                Your appeal has been received. Our team will review it and respond to{' '}
                <strong style={{ color: 'var(--text)' }}>{user?.email}</strong> within 48–72 hours.
              </p>
              <button
                className="btn"
                onClick={() => { setSubmitted(false); setForm({ account_id: '', reason: 'drawdown_error', description: '' }) }}
                style={{ border: '1px solid var(--navy-border)', padding: '10px 24px', background: 'transparent', color: 'var(--text-muted)', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}
              >
                Submit Another Dispute
              </button>
            </div>
          ) : (
            <div className="card">
              {error && (
                <div style={{ background: 'rgba(97, 97, 97, 0.1)', border: '1px solid var(--red)', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', color: 'var(--red)', fontSize: '13px' }}>
                  {error}
                </div>
              )}

              {eligibleAccounts.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px' }}>
                  <div style={{ fontSize: '40px', marginBottom: '12px' }}>✅</div>
                  <h3 style={{ color: 'var(--text)', marginBottom: '8px' }}>No Eligible Accounts</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
                    Disputes can only be submitted for failed or expired challenge accounts.
                    You don't have any accounts in those states.
                  </p>
                </div>
              ) : (
                <div>
                  {/* Account selector */}
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px', letterSpacing: '0.08em' }}>
                      ACCOUNT TO DISPUTE
                    </label>
                    <select
                      value={form.account_id}
                      onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}
                      style={{ width: '100%', fontSize: '14px' }}
                      required
                    >
                      <option value="">— Select account —</option>
                      {eligibleAccounts.map(acc => (
                        <option key={acc.id} value={acc.id}>
                          {acc.account_type.toUpperCase()} ${parseFloat(acc.account_size).toLocaleString('en-US')} — {acc.status.toUpperCase()}
                          {acc.phase_end_date ? ` (ended ${new Date(acc.phase_end_date).toLocaleDateString()})` : ''}
                          {` · ID: ${acc.account_uid || acc.id}`}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Reason selector */}
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px', letterSpacing: '0.08em' }}>
                      REASON FOR DISPUTE
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      {DISPUTE_REASONS.map(r => (
                        <button
                          key={r.value}
                          type="button"
                          onClick={() => setForm(f => ({ ...f, reason: r.value }))}
                          style={{
                            padding: '9px 12px', borderRadius: '8px', cursor: 'pointer',
                            border: form.reason === r.value ? '1px solid var(--accent)' : '1px solid var(--navy-border)',
                            background: form.reason === r.value ? 'rgba(148, 148, 148, 0.1)' : 'var(--navy-card)',
                            color: form.reason === r.value ? 'var(--accent)' : 'var(--text-muted)',
                            fontSize: '12px', textAlign: 'left',
                            fontFamily: 'DM Sans, sans-serif', transition: 'all 0.15s'
                          }}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Description */}
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px', letterSpacing: '0.08em' }}>
                      DESCRIPTION
                    </label>
                    <textarea
                      value={form.description}
                      onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Describe the issue in detail. Include specific trade IDs, timestamps, prices, or screenshots if available."
                      rows={5}
                      maxLength={2000}
                      style={{
                        width: '100%', fontSize: '14px', resize: 'vertical',
                        background: 'var(--navy)', border: '1px solid var(--navy-border)',
                        borderRadius: '8px', padding: '10px 14px',
                        color: 'var(--text)', fontFamily: 'DM Sans, sans-serif', lineHeight: '1.6'
                      }}
                    />
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', textAlign: 'right', marginTop: '4px' }}>
                      {form.description.length} / 2000 (min 30)
                    </div>
                  </div>

                  <button
                    onClick={handleSubmit}
                    disabled={loading}
                    style={{
                      background: loading ? 'var(--navy-border)' : 'var(--accent)',
                      color: loading ? 'var(--text-muted)' : 'var(--navy)',
                      border: 'none', borderRadius: '8px', padding: '12px 32px',
                      fontSize: '14px', fontWeight: '700', cursor: loading ? 'not-allowed' : 'pointer',
                      fontFamily: 'DM Sans, sans-serif'
                    }}
                  >
                    {loading ? '⏳ Submitting...' : '📨 Submit Dispute'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right Panel ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Process info */}
          <div className="card" style={{ padding: '16px 20px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '12px', letterSpacing: '0.08em' }}>DISPUTE PROCESS</div>
            {[
              { step: '1', text: 'Submit your dispute with account details and reason' },
              { step: '2', text: 'Admin reviews your trading history and account data' },
              { step: '3', text: 'Decision within 48–72 hours via email' },
              { step: '4', text: 'If upheld, account is restored or extended' },
            ].map(s => (
              <div key={s.step} style={{ display: 'flex', gap: '12px', marginBottom: '10px', alignItems: 'flex-start' }}>
                <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(148, 148, 148, 0.15)', border: '1px solid var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', color: 'var(--accent)', fontWeight: '700', flexShrink: 0 }}>
                  {s.step}
                </div>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5' }}>{s.text}</span>
              </div>
            ))}
          </div>

          {/* My disputes history */}
          {myDisputes.length > 0 && (
            <div className="card" style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '12px', letterSpacing: '0.08em' }}>MY DISPUTES</div>
              {myDisputes.map(d => (
                <div key={d.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--navy-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', color: 'var(--text)', fontWeight: '600' }}>#{d.id}</span>
                    <span style={{ fontSize: '11px', color: statusColors[d.status] || 'var(--text-dim)', fontWeight: '600', textTransform: 'uppercase' }}>
                      {d.status?.replace('_', ' ')}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {DISPUTE_REASONS.find(r => r.value === d.reason)?.label || d.reason}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '3px', fontFamily: 'DM Mono, monospace' }}>
                    Account ID: {d.account_uid || d.account_id || '—'}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '3px' }}>
                    {d.created_at ? new Date(d.created_at).toLocaleDateString() : ''}
                  </div>
                  {d.admin_response && (
                    <div style={{ marginTop: '8px', padding: '8px 10px', background: 'rgba(133, 133, 133, 0.06)', border: '1px solid rgba(133, 133, 133, 0.2)', borderRadius: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      <strong style={{ color: 'var(--cyan)', fontSize: '10px' }}>ADMIN RESPONSE: </strong>
                      {d.admin_response}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
