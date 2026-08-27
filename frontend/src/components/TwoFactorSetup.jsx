/**
 * TwoFactorSetup.js
 *
 * A self-contained component that handles the full user 2FA lifecycle:
 *   1. Shows current status (enabled / disabled)
 *   2. Setup flow: GET QR code → scan → enter code → show backup codes
 *   3. Disable flow: enter password + TOTP code
 *
 * Usage:
 *   import TwoFactorSetup from '../components/TwoFactorSetup'
 *   <TwoFactorSetup apiBase="http://localhost:5000" />
 *
 * The component reads/writes via httpOnly cookie auth and the standard
 * /api/auth/2fa/* endpoints.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'

const ax = axios.create({ withCredentials: true })

// ── Small helpers ──────────────────────────────────────────────────────────────
function Card({ children, style }) {
  return (
    <div style={{
      background: 'var(--navy-card)',
      border: '1px solid var(--navy-border)',
      borderRadius: '0',
      padding: 'var(--space-6)',
      ...style
    }}>
      {children}
    </div>
  )
}

function Btn({ children, variant = 'default', disabled, onClick, style: s, ...rest }) {
  const colors = {
    default: { bg: 'var(--ink)', border: 'var(--ink)', color: 'var(--paper)' },
    accent:  { bg: 'var(--ink)', border: 'var(--ink)', color: 'var(--paper)' },
    red:     { bg: 'transparent', border: 'var(--loss)', color: 'var(--loss)' },
    green:   { bg: 'transparent', border: 'var(--gain)', color: 'var(--gain)' },
    ghost:   { bg: 'transparent', border: 'var(--rule)', color: 'var(--muted)' },
  }
  const c = colors[variant] || colors.default
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: 'var(--space-2-5) var(--space-5)',
        borderRadius: '0',
        border: `1px solid ${c.border}`,
        background: c.bg,
        color: c.color,
        fontSize: 'var(--fs-base)',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'opacity 0.15s',
        ...s
      }}
      {...rest}
    >
      {children}
    </button>
  )
}

function Alert({ type = 'info', children }) {
  const styles = {
    error:   { border: 'var(--loss)', color: 'var(--loss)' },
    success: { border: 'var(--gain)', color: 'var(--gain)' },
    warning: { border: 'var(--warn)', color: 'var(--warn)' },
    info:    { border: 'var(--rule)', color: 'var(--ink)' },
  }
  const s = styles[type] || styles.info
  return (
    <div style={{
      background: 'transparent', border: `1px solid ${s.border}`, color: s.color,
      padding: 'var(--space-3) var(--space-4)', fontSize: 'var(--fs-base)',
      lineHeight: 1.6, marginBottom: 'var(--space-4)'
    }}>
      {children}
    </div>
  )
}

// ── Six-box TOTP input ─────────────────────────────────────────────────────────
function TotpBox({ onComplete, disabled }) {
  const [digits, setDigits] = useState(['', '', '', '', '', ''])
  const refs = Array.from({ length: 6 }, () => useRef())  // eslint-disable-line

  useEffect(() => { refs[0].current?.focus() }, [])  // eslint-disable-line

  function handleDigit(i, v) {
    const d = v.replace(/\D/g, '').slice(0, 1)
    const next = [...digits]
    next[i] = d
    setDigits(next)
    if (d && i < 5) refs[i + 1].current?.focus()
    if (d && i === 5) {
      const code = [...next.slice(0, 5), d].join('')
      if (code.length === 6) onComplete(code)
    }
  }

  function handleKey(i, e) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs[i - 1].current?.focus()
    if (e.key === 'Enter') {
      const code = digits.join('')
      if (code.length === 6) onComplete(code)
    }
  }

  function handlePaste(e) {
    const p = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (p.length === 6) { setDigits(p.split('')); onComplete(p) }
  }

  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' }} onPaste={handlePaste}>
      {digits.map((d, i) => (
        <input key={i} ref={refs[i]}
          type="text" inputMode="numeric" pattern="[0-9]*" maxLength={1}
          value={d} disabled={disabled}
          onChange={e => handleDigit(i, e.target.value)}
          onKeyDown={e => handleKey(i, e)}
          style={{
            width: '44px', height: '52px', textAlign: 'center',
            fontSize: 'var(--fs-3xl)', fontFamily: 'monospace', fontWeight: 700,
            background: 'var(--navy-hover)',
            border: `2px solid ${d ? 'var(--accent)' : 'var(--navy-border)'}`,
            borderRadius: '0', color: 'var(--text)', outline: 'none',
            transition: 'border-color 0.2s',
          }}
        />
      ))}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────────
function TwoFactorSetup({ apiBase = '' }) {
  const BASE = apiBase

  // Status
  const [is2faEnabled, setIs2faEnabled] = useState(null)  // null = loading
  const [statusError, setStatusError]   = useState('')

  // Setup flow
  const [setupPhase, setSetupPhase] = useState('idle')  // 'idle' | 'qr' | 'verifying' | 'done'
  const [qrUrl, setQrUrl]           = useState('')
  const [plainSecret, setPlainSecret] = useState('')
  const [setupError, setSetupError] = useState('')
  const [setupLoading, setSetupLoading] = useState(false)
  const [backupCodes, setBackupCodes]   = useState([])
  const [codesCopied, setCodesCopied]   = useState(false)

  // Disable flow
  const [disablePhase, setDisablePhase]       = useState('idle')  // 'idle' | 'confirm'
  const [disablePassword, setDisablePassword] = useState('')
  const [disableError, setDisableError]       = useState('')
  const [disableLoading, setDisableLoading]   = useState(false)

  // ── Fetch status ───────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const r = await ax.get(`${BASE}/api/auth/2fa/status`)
      setIs2faEnabled(r.data.totp_enabled)
    } catch {
      setStatusError('Could not load 2FA status. Make sure you are logged in.')
    }
  }, [BASE])

  useEffect(() => {
    queueMicrotask(() => { void fetchStatus() })
  }, [fetchStatus])

  // ── Setup: step 1 — get QR ─────────────────────────────────────────────────
  async function startSetup() {
    setSetupError('')
    setSetupLoading(true)
    try {
      const r = await ax.post(`${BASE}/api/auth/2fa/setup`)
      setQrUrl(r.data.qr)
      setPlainSecret(r.data.secret)
      setSetupPhase('qr')
    } catch (err) {
      setSetupError(err.response?.data?.error || 'Setup failed')
    }
    setSetupLoading(false)
  }

  // ── Setup: step 2 — verify code ────────────────────────────────────────────
  async function verifySetup(code) {
    setSetupError('')
    setSetupLoading(true)
    try {
      const r = await ax.post(`${BASE}/api/auth/2fa/verify-setup`, { token: code })
      setBackupCodes(r.data.backup_codes || [])
      setSetupPhase('done')
      setIs2faEnabled(true)
    } catch (err) {
      setSetupError(err.response?.data?.error || 'Invalid code. Please try again.')
    }
    setSetupLoading(false)
  }

  // ── Disable ────────────────────────────────────────────────────────────────
  async function disableTotp(totpCode) {
    setDisableError('')
    setDisableLoading(true)
    try {
      await ax.post(`${BASE}/api/auth/2fa/disable`, {
        token:    totpCode,
        password: disablePassword,
      })
      setIs2faEnabled(false)
      setDisablePhase('idle')
      setDisablePassword('')
    } catch (err) {
      setDisableError(err.response?.data?.error || 'Could not disable 2FA')
    }
    setDisableLoading(false)
  }

  // ── Copy backup codes ──────────────────────────────────────────────────────
  function copyBackupCodes() {
    navigator.clipboard.writeText(backupCodes.join('\n')).then(() => {
      setCodesCopied(true)
      setTimeout(() => setCodesCopied(false), 3000)
    })
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (is2faEnabled === null) {
    return (
      <Card>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)' }}>
          {statusError || 'Loading 2FA status…'}
        </div>
      </Card>
    )
  }

  // ── SETUP — QR phase ──────────────────────────────────────────────────────
  if (setupPhase === 'qr') {
    return (
      <Card>
        <h3 style={{ color: 'var(--text)', marginBottom: 'var(--space-1-5)' }}>🔐 Set Up Two-Factor Authentication</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', marginBottom: 'var(--space-5)', lineHeight: 1.6 }}>
          Scan the QR code with Google Authenticator or Authy. Then enter the 6-digit code below to confirm.
        </p>

        {setupError && <Alert type="error">{setupError}</Alert>}

        {/* QR Code */}
        {qrUrl && (
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-5)' }}>
            <div style={{
              // design-drift-allow: a QR code needs a white quiet zone to scan reliably;
              // theming this surface breaks authenticator apps in dark mode.
              display: 'inline-block', background: '#fff',
              padding: 'var(--space-3)', border: '1px solid var(--rule)'
            }}>
              <img src={qrUrl} alt="2FA QR Code" style={{ display: 'block', width: '180px', height: '180px' }} />
            </div>
          </div>
        )}

        {/* Manual secret */}
        {plainSecret && (
          <div style={{ marginBottom: 'var(--space-6)' }}>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-1-5)', letterSpacing: '0.06em' }}>
              CAN'T SCAN? ENTER THIS KEY MANUALLY:
            </div>
            <div style={{
              background: 'var(--navy-hover)', border: '1px solid var(--navy-border)',
              borderRadius: '0', padding: 'var(--space-3) var(--space-3-5)',
              fontFamily: 'monospace', fontSize: 'var(--fs-md)',
              color: 'var(--accent)', letterSpacing: '0.12em',
              wordBreak: 'break-all', textAlign: 'center'
            }}>
              {plainSecret}
            </div>
          </div>
        )}

        {/* 6-digit verify */}
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2-5)', letterSpacing: '0.06em', textAlign: 'center' }}>
            ENTER THE 6-DIGIT CODE FROM YOUR APP
          </div>
          <TotpBox onComplete={verifySetup} disabled={setupLoading} />
        </div>

        {setupLoading && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-2)' }}>
            Verifying…
          </div>
        )}

        <div style={{ marginTop: 'var(--space-4)' }}>
          <Btn variant="ghost" onClick={() => { setSetupPhase('idle'); setSetupError('') }} style={{ width: '100%' }}>
            Cancel
          </Btn>
        </div>
      </Card>
    )
  }

  // ── SETUP — backup codes phase ─────────────────────────────────────────────
  if (setupPhase === 'done') {
    return (
      <Card>
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-5)' }}>
          <div style={{ fontSize: 'var(--fs-6xl)' }}>✅</div>
          <h3 style={{ color: 'var(--text)', marginTop: 'var(--space-2)' }}>2FA Enabled Successfully!</h3>
        </div>

        <Alert type="warning">
          <strong>Save these backup codes now.</strong> They will <em>not</em> be shown again.
          Each code can only be used once if you lose access to your authenticator app.
        </Alert>

        {/* Backup codes grid */}
        <div style={{
          background: 'var(--navy-hover)', border: '1px solid var(--navy-border)',
          borderRadius: '0', padding: 'var(--space-4)', marginBottom: 'var(--space-4)'
        }}>
          <div className="ui-cols" style={{ '--cols-gap': '8px' }}>
            {backupCodes.map((code, i) => (
              <div key={i} style={{
                fontFamily: 'monospace', fontSize: 'var(--fs-md)',
                color: 'var(--text)', letterSpacing: '0.08em',
                background: 'var(--navy-card)', borderRadius: '0',
                padding: 'var(--space-2) var(--space-3)', textAlign: 'center',
                border: '1px solid var(--navy-border)'
              }}>
                {code}
              </div>
            ))}
          </div>
        </div>

        <Btn variant="accent" onClick={copyBackupCodes} style={{ width: '100%', marginBottom: 'var(--space-2-5)' }}>
          {codesCopied ? '✓ Copied!' : '📋 Copy All Backup Codes'}
        </Btn>
        <Btn variant="ghost" onClick={() => { setSetupPhase('idle'); setBackupCodes([]) }} style={{ width: '100%' }}>
          Done
        </Btn>
      </Card>
    )
  }

  // ── DISABLE — confirm phase ────────────────────────────────────────────────
  if (disablePhase === 'confirm') {
    return (
      <Card>
        <h3 style={{ color: 'var(--text)', marginBottom: 'var(--space-1-5)' }}>Disable Two-Factor Authentication</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', marginBottom: 'var(--space-5)', lineHeight: 1.6 }}>
          Enter your account password and a valid 2FA code to confirm.
        </p>

        {disableError && <Alert type="error">{disableError}</Alert>}

        <div style={{ marginBottom: 'var(--space-3-5)' }}>
          <label style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-1-5)', letterSpacing: '0.06em' }}>ACCOUNT PASSWORD</label>
          <input
            type="password"
            value={disablePassword}
            onChange={e => setDisablePassword(e.target.value)}
            placeholder="Your account password"
            style={{
              width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)',
              borderRadius: '0', padding: 'var(--space-2-5) var(--space-3)', color: 'var(--text)', fontSize: 'var(--fs-md)'
            }}
          />
        </div>

        <div style={{ marginBottom: 'var(--space-5)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2-5)', letterSpacing: '0.06em', textAlign: 'center' }}>
            2FA CODE FROM AUTHENTICATOR APP
          </div>
          <TotpBox onComplete={disableTotp} disabled={disableLoading} />
        </div>

        {disableLoading && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--space-2)' }}>
            Disabling 2FA…
          </div>
        )}

        <Btn variant="ghost" onClick={() => { setDisablePhase('idle'); setDisableError(''); setDisablePassword('') }} style={{ width: '100%' }}>
          Cancel
        </Btn>
      </Card>
    )
  }

  // ── STATUS VIEW (default) ──────────────────────────────────────────────────
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)' }}>
        <div style={{
          width: '44px', height: '44px', borderRadius: '0', flexShrink: 0,
          background: is2faEnabled ? 'color-mix(in srgb, var(--gain) 12%, transparent)' : 'color-mix(in srgb, var(--loss) 8%, transparent)',
          border: `1px solid ${is2faEnabled ? 'color-mix(in srgb, var(--gain) 25%, transparent)' : 'color-mix(in srgb, var(--loss) 20%, transparent)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--fs-2xl)'
        }}>
          {is2faEnabled ? '🔐' : '🔓'}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)', marginBottom: 'var(--space-1)' }}>
            <span style={{ color: 'var(--text)', fontWeight: 700, fontSize: 'var(--fs-lg)' }}>
              Two-Factor Authentication
            </span>
            <span style={{
              padding: 'var(--space-1) var(--space-2)', borderRadius: '0', fontSize: 'var(--fs-xs)', fontWeight: 600,
              background: is2faEnabled ? 'color-mix(in srgb, var(--gain) 12%, transparent)' : 'color-mix(in srgb, var(--loss) 8%, transparent)',
              color: is2faEnabled ? 'var(--gain)' : 'var(--loss)',
              border: `1px solid ${is2faEnabled ? 'color-mix(in srgb, var(--gain) 25%, transparent)' : 'color-mix(in srgb, var(--loss) 20%, transparent)'}`
            }}>
              {is2faEnabled ? 'ENABLED' : 'DISABLED'}
            </span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', lineHeight: 1.6, margin: 0 }}>
            {is2faEnabled
              ? 'Your account is protected with TOTP-based 2FA. You will need your authenticator app every time you log in.'
              : 'Enable 2FA to protect your account with a time-based one-time password (Google Authenticator, Authy, etc).'}
          </p>
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-5)', display: 'flex', gap: 'var(--space-2-5)' }}>
        {!is2faEnabled && (
          <Btn variant="accent" onClick={startSetup} disabled={setupLoading}>
            {setupLoading ? 'Loading…' : '🔐 Enable 2FA'}
          </Btn>
        )}
        {is2faEnabled && (
          <Btn variant="red" onClick={() => setDisablePhase('confirm')}>
            Disable 2FA
          </Btn>
        )}
      </div>

      {statusError && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Alert type="error">{statusError}</Alert>
        </div>
      )}
    </Card>
  )
}

export default TwoFactorSetup
