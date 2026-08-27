import React, { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { Link, useSearchParams } from 'react-router-dom'
import AuthMasthead from '../components/auth/AuthMasthead'
import { API_BASE_URL as API_URL } from '../config/apiBase'

// Landing target for the link in the verification email (backend builds it in
// routes/auth.js buildVerifyLink). Public on purpose: the link is opened from an
// inbox, which is often not the browser that registered.
export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams()
  const token = (searchParams.get('token') || '').trim()

  const [state, setState] = useState(token ? 'verifying' : 'missing')
  const [message, setMessage] = useState('')

  // React 18 StrictMode mounts effects twice in development. The verify call is
  // single-use by design — the token is cleared on success — so a second call
  // would report failure for a link that had just worked.
  const requested = useRef(false)

  useEffect(() => {
    if (!token || requested.current) return
    requested.current = true

    axios.post(`${API_URL}/api/auth/verify-email`, { token })
      .then((res) => {
        setState(res.data?.verified ? 'verified' : 'invalid')
        setMessage(res.data?.message || '')
      })
      .catch((err) => {
        setState('error')
        setMessage(err.response?.data?.error || 'Could not reach the server. Please try again.')
      })
  }, [token])

  const copy = {
    verifying: { eyebrow: 'Confirming', title: 'Checking your link…', body: 'One moment.' },
    verified: { eyebrow: 'Confirmed', title: 'Your email is verified.', body: 'Thanks — that is everything we needed. You can head to your dashboard.' },
    invalid: { eyebrow: 'Link expired', title: 'This link is no longer valid.', body: message || 'Request a fresh link from your dashboard.' },
    missing: { eyebrow: 'Nothing to confirm', title: 'No verification token found.', body: 'Open the link directly from the email we sent you.' },
    error: { eyebrow: 'Something went wrong', title: 'We could not confirm this link.', body: message },
  }[state]

  const tone = state === 'verified' ? 'var(--gain)' : state === 'verifying' ? 'var(--accent)' : 'var(--warn)'

  return (
    <div className="auth-shell">
      <AuthMasthead eyebrow="Section B · Email Verification" maxWidth={460} />

      <div
        className="lx-card auth-glass-card"
        style={{ width: 'min(100%, 460px)', zIndex: 10, padding: 'var(--space-8) var(--space-7)', textAlign: 'center' }}
      >
        <span className="auth-eyebrow" style={{ display: 'block', marginBottom: 'var(--space-3)', color: tone }}>
          {copy.eyebrow}
        </span>
        <h1
          style={{
            fontSize: 'var(--fs-3xl)', fontWeight: 800, letterSpacing: '-0.02em',
            color: 'var(--text-primary)', marginBottom: 'var(--space-3)',
          }}
        >
          {copy.title}
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-md)', lineHeight: 1.6, margin: 0 }}>
          {copy.body}
        </p>

        <div style={{ marginTop: 'var(--space-7)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <Link to="/dashboard" className="btn btn-primary" style={{ width: '100%' }}>
            Go to dashboard
          </Link>
          <Link to="/login" style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-base)' }}>
            Sign in instead
          </Link>
        </div>
      </div>
    </div>
  )
}
