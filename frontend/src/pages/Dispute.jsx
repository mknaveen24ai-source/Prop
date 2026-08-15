import React, { useEffect, useState } from 'react'
import axios from 'axios'
import { renderIcon } from '../utils/iconMap'
import Card from '../components/ui/Card'
import { getStatusToneColor } from '../utils/statusTone'
import { API_BASE_URL as API_URL } from '../config/apiBase'

const DRAFT_KEY = 'dispute-draft'
const MAX_EVIDENCE_BYTES = 600 * 1024

// Must match backend/routes/disputes.js's VALID_REASONS exactly — the
// previous version of this screen sent short slugs ('drawdown_error') that
// never matched the backend's allowlist, so every submission silently
// failed validation. Fixed by using the same strings both sides.
const DISPUTE_REASONS = [
  'Incorrect drawdown calculation',
  'Technical issue during challenge',
  'Price feed error',
  'Incorrect trade closure',
  'Account expired incorrectly',
  'Other',
]

const APPEAL_TIMELINE = [
  { label: 'Submit your appeal', meta: 'Account, reason, description, evidence' },
  { label: 'Admin reviews your trading history', meta: 'Trade log and account data checked against the claim' },
  { label: 'Decision communicated by email', meta: 'Typically within 48–72 hours' },
  { label: 'If upheld, account is restored or extended', meta: 'Otherwise the original ruling stands' },
]

function formatDateTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function titleCase(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function Dispute({ user, accounts }) {
  const [form, setForm] = useState({ account_id: '', reason: DISPUTE_REASONS[0], description: '' })
  const [evidenceFile, setEvidenceFile] = useState(null)
  const [evidenceDataUrl, setEvidenceDataUrl] = useState(null)
  const [evidenceError, setEvidenceError] = useState('')
  const [violationContext, setViolationContext] = useState(null)
  const [overturnRates, setOverturnRates] = useState([])
  const [myDisputes, setMyDisputes] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [successId, setSuccessId] = useState(null)
  const [draftSaved, setDraftSaved] = useState(false)

  // Only failed/expired accounts can be disputed
  const eligibleAccounts = (accounts || []).filter((a) => ['failed', 'expired'].includes(a.status))

  useEffect(() => {
    fetchMyDisputes()
    axios.get(`${API_URL}/api/disputes/overturn-rates`).then((res) => setOverturnRates(res.data || [])).catch(() => setOverturnRates([]))

    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null')
      if (saved && saved.description) setForm((f) => ({ ...f, ...saved }))
    } catch { /* ignore malformed draft */ }
  }, [])

  useEffect(() => {
    if (!form.account_id) { setViolationContext(null); return }
    axios.get(`${API_URL}/api/disputes/violation-context/${form.account_id}`)
      .then((res) => setViolationContext(res.data))
      .catch(() => setViolationContext(null))
  }, [form.account_id])

  async function fetchMyDisputes() {
    try {
      const res = await axios.get(`${API_URL}/api/disputes/my-disputes`)
      setMyDisputes(res.data || [])
    } catch { setMyDisputes([]) }
  }

  function handleFileChange(e) {
    const file = e.target.files[0]
    if (!file) return
    setEvidenceError('')
    if (!['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'].includes(file.type)) {
      setEvidenceError('Evidence must be a JPG, PNG or PDF')
      setEvidenceFile(null)
      setEvidenceDataUrl(null)
      return
    }
    if (file.size > MAX_EVIDENCE_BYTES) {
      setEvidenceError(`Evidence must be under ${Math.round(MAX_EVIDENCE_BYTES / 1024)}KB`)
      setEvidenceFile(null)
      setEvidenceDataUrl(null)
      return
    }
    const reader = new FileReader()
    reader.onload = () => { setEvidenceFile(file); setEvidenceDataUrl(reader.result) }
    reader.readAsDataURL(file)
  }

  function saveDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ account_id: form.account_id, reason: form.reason, description: form.description }))
    setDraftSaved(true)
    setTimeout(() => setDraftSaved(false), 2500)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!form.account_id) return setError('Please select the account you are disputing.')
    if (form.description.trim().length < 30) return setError('Please describe your issue in at least 30 characters.')
    setLoading(true)
    try {
      const res = await axios.post(`${API_URL}/api/disputes/submit`, {
        account_id: form.account_id,
        reason: form.reason,
        description: form.description.trim(),
        evidence_data_url: evidenceDataUrl || undefined,
      })
      setSuccessId(res.data?.dispute?.id || true)
      localStorage.removeItem(DRAFT_KEY)
      setForm({ account_id: '', reason: DISPUTE_REASONS[0], description: '' })
      setEvidenceFile(null)
      setEvidenceDataUrl(null)
      fetchMyDisputes()
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit dispute. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (eligibleAccounts.length === 0) {
    return (
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '22px', marginBottom: '8px' }}>File an Appeal</h2>
        <Card style={{ textAlign: 'center', padding: '48px 32px', marginTop: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('approve', { size: 40, color: 'var(--gain)' })}
          </div>
          <h3 style={{ marginBottom: '8px' }}>No Eligible Accounts</h3>
          <p style={{ color: 'var(--muted)', fontSize: '14px' }}>
            Appeals can only be filed for failed or expired challenge accounts. You don't have any accounts in those states.
          </p>
        </Card>
      </div>
    )
  }

  const violation = violationContext?.violation

  return (
    <div style={{ maxWidth: '1020px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '22px', margin: 0 }}>File an Appeal</h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.35fr) minmax(0,1fr)', gap: '16px', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {successId && (
            <Card style={{ border: '1px solid var(--gain)' }}>
              <div style={{ color: 'var(--gain)', fontSize: '14px' }}>
                Appeal submitted{typeof successId === 'number' ? ` — #${successId}` : ''}. We'll respond to <strong>{user?.email}</strong> within 48–72 hours.
              </div>
            </Card>
          )}

          {/* Account selector — needed since a trader may have multiple
              disputable accounts; the prototype assumes a single violation
              context, this app doesn't. */}
          <Card>
            <label style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Account to appeal</label>
            <select
              value={form.account_id}
              onChange={(e) => setForm((f) => ({ ...f, account_id: e.target.value }))}
              style={{ width: '100%', marginTop: '8px', padding: '10px 12px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'var(--paper)', color: 'var(--ink)', fontSize: '13px' }}
            >
              <option value="">— Select account —</option>
              {eligibleAccounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.account_type.toUpperCase()} ${parseFloat(acc.account_size).toLocaleString('en-US')} — {acc.status.toUpperCase()} · {acc.account_uid || acc.id}
                </option>
              ))}
            </select>
          </Card>

          {/* Violation under appeal — matches the prototype's isDispute
              summary card, sourced from the real admin_rule_violations row
              linked at submission time (or shown here as pre-submit context). */}
          {form.account_id && violation && (
            <div style={{ border: '1px solid var(--loss)', borderRadius: '4px', background: 'var(--glass-2)', backdropFilter: 'blur(16px)', boxShadow: 'var(--elev)', padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <span style={{ display: 'inline-flex', color: 'var(--loss)', marginTop: '3px' }}>{renderIcon('warning', { size: 18, color: 'var(--loss)' })}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--loss)' }}>Violation under appeal · V-{violation.id}</div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: '20px', marginTop: '6px' }}>{titleCase(violation.violation_type)}</div>
                  <div style={{ fontSize: '13px', color: 'var(--muted)', marginTop: '6px', lineHeight: 1.6 }}>{violation.message}</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginTop: '16px', borderTop: '1px solid var(--rule-soft)', paddingTop: '14px' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Account</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', marginTop: '4px' }}>{violationContext.account_uid}</div>
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Detected</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', marginTop: '4px' }}>{formatDateTime(violation.first_detected_at)}</div>
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Severity</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', marginTop: '4px', color: 'var(--loss)' }}>{titleCase(violation.severity)}</div>
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>Source</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', marginTop: '4px' }}>System-flagged</div>
                </div>
              </div>
            </div>
          )}
          {form.account_id && !violation && (
            <Card style={{ padding: '14px 18px', fontSize: '12.5px', color: 'var(--muted)' }}>
              No system-flagged violation found for this account — you can still describe what happened below.
            </Card>
          )}

          <Card ruled title="Grounds for appeal">
            {error && (
              <div style={{ background: 'color-mix(in srgb, var(--loss) 10%, transparent)', border: '1px solid var(--loss)', padding: '10px 14px', marginBottom: '16px', color: 'var(--loss)', fontSize: '13px' }}>
                {error}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '8px' }}>
              {DISPUTE_REASONS.map((r) => {
                const active = form.reason === r
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, reason: r }))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '9px', padding: '9px 12px',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--rule)'}`, borderRadius: '4px',
                      background: active ? 'var(--glass)' : 'transparent', cursor: 'pointer'
                    }}
                  >
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: active ? 'var(--accent)' : 'var(--rule)', flex: '0 0 auto' }} />
                    <span style={{ flex: 1, textAlign: 'left', fontSize: '12.5px' }}>{r}</span>
                  </button>
                )
              })}
            </div>

            <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)', margin: '18px 0 7px' }}>
              Your account of what happened
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={6}
              maxLength={2000}
              placeholder="Describe the sequence of events, with times in UTC. Attach platform screenshots below."
              style={{ width: '100%', resize: 'vertical', padding: '12px 14px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'var(--paper)', color: 'var(--ink)', fontSize: '13.5px', lineHeight: 1.6 }}
            />
            <div style={{ fontSize: '11px', color: 'var(--muted)', textAlign: 'right', marginTop: '4px' }}>{form.description.length} / 2000 (min 30)</div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px', padding: '12px 14px', border: '1px dashed var(--rule)', borderRadius: '4px' }}>
              <span style={{ display: 'inline-flex', color: 'var(--accent)' }}>{renderIcon('file', { size: 16, color: 'var(--accent)' })}</span>
              <div style={{ flex: 1, fontSize: '12.5px', color: 'var(--muted)' }}>
                {evidenceFile ? `${evidenceFile.name} (${Math.round(evidenceFile.size / 1024)}KB)` : `Attach evidence — trade log, platform screenshot or broker statement (under ${Math.round(MAX_EVIDENCE_BYTES / 1024)}KB)`}
                {evidenceError && <div style={{ color: 'var(--loss)', marginTop: '4px' }}>{evidenceError}</div>}
              </div>
              <label style={{ padding: '8px 14px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'transparent', color: 'var(--ink)', fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '.1em', textTransform: 'uppercase', cursor: 'pointer' }}>
                Browse
                <input type="file" accept=".jpg,.jpeg,.png,.pdf" onChange={handleFileChange} style={{ display: 'none' }} />
              </label>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <button
                onClick={handleSubmit}
                disabled={loading}
                style={{ flex: 1, padding: '13px', border: '1px solid var(--accent)', borderRadius: '4px', background: 'var(--accent)', color: 'var(--paper)', fontFamily: 'var(--font-mono)', fontSize: '11.5px', letterSpacing: '.12em', textTransform: 'uppercase', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1 }}
              >
                {loading ? 'Submitting…' : 'Submit appeal'}
              </button>
              <button
                type="button"
                onClick={saveDraft}
                style={{ padding: '13px 18px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'transparent', color: draftSaved ? 'var(--gain)' : 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: '11.5px', letterSpacing: '.12em', textTransform: 'uppercase', cursor: 'pointer' }}
              >
                {draftSaved ? 'Saved ✓' : 'Save draft'}
              </button>
            </div>
          </Card>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Card title="How appeals run">
            {APPEAL_TIMELINE.map((t, idx) => (
              <div key={t.label} style={{ display: 'flex', gap: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 auto' }}>
                  <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: 'var(--accent)', flex: '0 0 auto' }} />
                  {idx < APPEAL_TIMELINE.length - 1 && <span style={{ width: '1px', flex: 1, background: 'var(--rule)', marginTop: '2px' }} />}
                </div>
                <div style={{ paddingBottom: '16px' }}>
                  <div style={{ fontSize: '13px' }}>{t.label}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--muted)', marginTop: '3px' }}>{t.meta}</div>
                </div>
              </div>
            ))}
          </Card>

          <Card title="Overturn rates" eyebrow="Platform-wide, decided appeals">
            {overturnRates.length === 0 ? (
              <div style={{ fontSize: '12.5px', color: 'var(--muted)' }}>Not enough decided appeals yet to show a rate.</div>
            ) : (
              overturnRates.map((o) => (
                <div key={o.label} style={{ padding: '10px 0', borderBottom: '1px solid var(--rule-soft)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '12.5px' }}>
                    <span>{o.label}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--gain)' }}>{o.pct}%</span>
                  </div>
                  <div style={{ height: '6px', marginTop: '7px', border: '1px solid var(--rule)', borderRadius: '99px', background: 'var(--paper)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${o.pct}%`, background: 'var(--gain)' }} />
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>

      {/* My Appeals — real history, not in the prototype's single-ticket
          mock but necessary for a trader with more than one appeal. */}
      {myDisputes.length > 0 && (
        <Card ruled flush title="My Appeals">
          <table className="lx-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Account</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Filed</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {myDisputes.map((d) => (
                <React.Fragment key={d.id}>
                  <tr>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>#{d.id}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{d.account_uid || d.account_id}</td>
                    <td>{d.reason}</td>
                    <td><span className="lx-badge" style={{ color: getStatusToneColor(d.status) }}>{(d.status || '').replace('_', ' ')}</span></td>
                    <td style={{ color: 'var(--muted)' }}>{formatDateTime(d.created_at)}</td>
                    <td>
                      {d.has_evidence ? (
                        <a href={`${API_URL}/api/disputes/${d.id}/evidence`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: '12px' }}>View</a>
                      ) : <span style={{ color: 'var(--muted)', fontSize: '12px' }}>—</span>}
                    </td>
                  </tr>
                  {d.admin_response && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--glass)', fontSize: '12.5px', color: 'var(--muted)', padding: '10px 14px' }}>
                        <strong style={{ color: 'var(--ink)' }}>Admin response: </strong>{d.admin_response}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
