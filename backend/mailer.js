const nodemailer = require('nodemailer')
const fs = require('fs')
const path = require('path')
require('./loadEnv')

const EMAIL_TEMPLATE_KEYS = Object.freeze([
  'password_reset',
  'welcome_onboarding',
  'challenge_expiry_reminder',
  'challenge_inactivity_reminder',
  'phase_passed',
  'account_failed',
  'account_expired',
  'kyc_pending_reminder',
  'kyc_approved',
  'kyc_rejected',
  'payout_requested',
  'payout_approved',
  'payout_rejected',
  'affiliate_commission_earned',
  'affiliate_payout_requested',
  'affiliate_payout_approved',
  'affiliate_payout_rejected',
  'competition_prize_voucher',
  'gift_challenge_voucher',
  'referral_season_prize_voucher',
  'certificate_awarded'
])

let transporter = null

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase()
}

function isBrevoHost(host) {
  return normalizeHost(host) === 'smtp-relay.brevo.com'
}

function hasConfiguredSendGridKey() {
  const key = String(process.env.SENDGRID_API_KEY || '').trim()
  if (!key) return false
  const normalized = key.toLowerCase()
  return normalized !== 'your_sendgrid_key_goes_here' && normalized !== 'replace_me'
}

function resolveMailTransportConfig() {
  const smtpHost = String(process.env.SMTP_HOST || '').trim()
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10)
  const smtpUser = String(process.env.SMTP_USER || '').trim()
  const smtpPass = String(process.env.SMTP_PASS || '').trim()
  const fromEmail = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim()

  if (smtpHost && smtpUser && smtpPass) {
    return {
      mode: 'smtp',
      provider: isBrevoHost(smtpHost) ? 'brevo' : 'smtp',
      host: smtpHost,
      port: smtpPort,
      secure: String(process.env.SMTP_PORT || '587') === '465',
      user: smtpUser,
      fromEmail,
      usesBrevo: isBrevoHost(smtpHost)
    }
  }

  if (hasConfiguredSendGridKey()) {
    return {
      mode: 'sendgrid',
      provider: 'sendgrid',
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      user: 'apikey',
      fromEmail,
      usesBrevo: false
    }
  }

  return {
    mode: 'preview',
    provider: 'local_preview',
    host: null,
    port: null,
    secure: false,
    user: null,
    fromEmail,
    usesBrevo: false
  }
}

// Nodemailer's defaults are 2 min to connect, 30 s for the greeting and — the
// one that matters — 10 min on the socket. The email worker
// (workers/emailWorker.js) drains its batch serially, so a single wedged SMTP
// host could stall the whole queue for ten minutes per message while the job
// row sat in 'sending'. These bound that to well under the 15-minute stale
// reclaim window in utils/emailQueue.js, so a hung send is retried rather than
// blocking everything behind it.
const SMTP_TIMEOUTS = {
  connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 10000,
  greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 10000,
  socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || 30000
}

async function getMailTransporter() {
  if (transporter) return transporter

  const config = resolveMailTransportConfig()

  if (config.mode === 'smtp') {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      ...SMTP_TIMEOUTS
    })
    console.log(`[mail] SMTP: ${config.host}:${config.port}${config.usesBrevo ? ' (Brevo)' : ''}`)
  } else if (config.mode === 'sendgrid') {
    transporter = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY },
      ...SMTP_TIMEOUTS
    })
    console.log('[mail] SendGrid SMTP bridge enabled')
  } else {
    transporter = nodemailer.createTransport({
      jsonTransport: true
    })
    console.warn('[mail] No SMTP configured, using local preview transport.')
  }

  return transporter
}

async function verifyMailTransportConnection() {
  const config = resolveMailTransportConfig()

  if (config.mode === 'preview') {
    return {
      ok: false,
      skipped: true,
      reason: 'preview_transport',
      config
    }
  }

  const mailer = await getMailTransporter()
  if (typeof mailer.verify !== 'function') {
    return {
      ok: true,
      skipped: true,
      reason: 'verify_not_supported',
      config
    }
  }

  await mailer.verify()
  return {
    ok: true,
    skipped: false,
    reason: null,
    config
  }
}

function resolveMailContext() {
  const firmName = process.env.FIRM_NAME || process.env.PLATFORM_NAME || 'Prop Firm'
  const fromName = firmName
  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@propfirm.com'
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

  return {
    firmName,
    fromName,
    fromEmail,
    baseUrl
  }
}

function htmlWrap(title, body) {
  const context = resolveMailContext()
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#0d1b2a;color:#e8e0d0;border-radius:8px;">
      <h2 style="color:#c9a84c;font-family:sans-serif;margin-bottom:4px;">${context.firmName}</h2>
      <p style="color:#aaa;margin-bottom:24px;font-size:14px;">${title}</p>
      ${body}
      <hr style="border:none;border-top:1px solid #1e2d3d;margin:28px 0;">
      <p style="color:#555;font-size:12px;">
        ${context.firmName} - Simulated Trading Platform -
        <a href="${context.baseUrl}" style="color:#c9a84c;">Visit Platform</a>
      </p>
    </div>
  `
}

function formatUsd(value) {
  return `$${(Number(value) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

function isSupportedEmailTemplate(templateKey) {
  return EMAIL_TEMPLATE_KEYS.includes(String(templateKey || '').trim().toLowerCase())
}

function buildPasswordResetEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const resetLink = String(payload?.resetLink || '').trim()
  const resetToken = payload?.resetToken ? String(payload.resetToken) : ''
  const context = resolveMailContext()
  const subject = `${context.firmName} - Password Reset Request`
  const html = htmlWrap('Password Reset Request', `
    <p>You requested a password reset. Go to the link below and enter the code to set a new password.</p>
    <p style="margin:28px 0;">
      <a href="${resetLink}" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
        Go to Reset Page
      </a>
    </p>
    ${resetToken ? `
    <div style="background:#1e2d3d;border:1px solid #c9a84c;border-radius:6px;padding:16px;text-align:center;margin:20px 0;">
      <p style="color:#aaa;font-size:13px;margin:0 0 8px;">Your reset code:</p>
      <p style="font-size:24px;font-weight:700;color:#c9a84c;letter-spacing:2px;margin:0;font-family:monospace;">${resetToken}</p>
    </div>
    <p style="color:#888;font-size:13px;">This code expires in <strong>1 hour</strong>. If you did not request this, ignore this email.</p>
    ` : `<p style="color:#888;font-size:13px;">This link expires in <strong>1 hour</strong>. If you did not request this, ignore this email.</p>`}
  `)

  return {
    to,
    subject,
    html,
    text: `Reset your password: ${resetLink}${resetToken ? ` (Code: ${resetToken})` : ''}`
  }
}

function buildWelcomeOnboardingEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const traderUid = String(payload?.traderUid || '').trim()
  const affiliateCode = String(payload?.affiliateCode || '').trim()
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Welcome to the Platform`,
    html: htmlWrap(`Welcome ${fullName}`, `
      <p>Your account is live and ready. We designed the platform to feel clear, fast, and trustworthy from the start.</p>
      <div style="background:#13253a;border:1px solid #1e2d3d;border-radius:8px;padding:16px 18px;margin:18px 0;">
        <p style="margin:0 0 10px;font-weight:700;color:#e8e0d0;">Best next steps</p>
        <ol style="margin:0;padding-left:18px;color:#cbd5e1;">
          <li style="margin-bottom:8px;">Open your dashboard and start your challenge.</li>
          <li style="margin-bottom:8px;">Complete KYC early so payouts are not delayed later.</li>
          <li>Review the rules and payout flow before your first trade.</li>
        </ol>
      </div>
      ${(traderUid || affiliateCode) ? `
      <div style="background:#0f1724;border:1px solid #1e2d3d;border-radius:8px;padding:14px 16px;margin:16px 0;">
        ${traderUid ? `<p style="margin:0 0 8px;color:#94a3b8;font-size:13px;">Trader UID: <span style="color:#e8e0d0;font-family:monospace;">${traderUid}</span></p>` : ''}
        ${affiliateCode ? `<p style="margin:0;color:#94a3b8;font-size:13px;">Affiliate code: <span style="color:#e8e0d0;font-family:monospace;">${affiliateCode}</span></p>` : ''}
      </div>
      ` : ''}
      <p style="margin:24px 0;">
        <a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
          Open Dashboard
        </a>
      </p>
      <p style="color:#94a3b8;font-size:13px;">Need help? Sign in and open a support request from the portal.</p>
    `),
    text: `Welcome to ${context.firmName}. Open your dashboard at ${context.baseUrl}/dashboard, complete KYC, and review the trading rules before you begin.`
  }
}

function buildChallengeExpiryReminderEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const accountType = String(payload?.accountType || 'phase1').trim().toUpperCase()
  const accountSize = Number(payload?.accountSize || 0)
  const daysRemaining = Math.max(0, parseInt(payload?.daysRemaining, 10) || 0)
  const phaseEndDate = payload?.phaseEndDate ? new Date(payload.phaseEndDate) : null
  const context = resolveMailContext()
  const readableDate = phaseEndDate && Number.isFinite(phaseEndDate.getTime())
    ? phaseEndDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'soon'
  return {
    to,
    subject: `${context.firmName} - ${daysRemaining} Day${daysRemaining === 1 ? '' : 's'} Left In Your Challenge`,
    html: htmlWrap(`Hi ${fullName}, your ${accountType} challenge window is closing.`, `
      <p>You have <strong style="color:#c9a84c;">${daysRemaining} day${daysRemaining === 1 ? '' : 's'}</strong> left on your ${formatUsd(accountSize)} ${accountType} account.</p>
      <div style="background:#13253a;border:1px solid #1e2d3d;border-radius:8px;padding:16px 18px;margin:18px 0;">
        <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;">Challenge end date</p>
        <p style="margin:0;color:#e8e0d0;font-weight:700;">${readableDate}</p>
      </div>
      <p>Review your progress, your rules, and your remaining time so you can finish the phase cleanly.</p>
      <p style="margin:24px 0;">
        <a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
          Open Dashboard
        </a>
      </p>
    `),
    text: `You have ${daysRemaining} day(s) left in your ${accountType} challenge. Log in at ${context.baseUrl}/dashboard to review your progress.`
  }
}

function buildChallengeInactivityReminderEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const accountType = String(payload?.accountType || 'phase1').trim().toUpperCase()
  const accountSize = Number(payload?.accountSize || 0)
  const inactivityFailDays = Math.max(1, parseInt(payload?.inactivityFailDays, 10) || 30)
  const daysUntilFail = Math.max(0, parseInt(payload?.daysUntilFail, 10) || 0)
  const lastActivityAt = payload?.lastActivityAt ? new Date(payload.lastActivityAt) : null
  const context = resolveMailContext()
  const readableLastActivity = lastActivityAt && Number.isFinite(lastActivityAt.getTime())
    ? lastActivityAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'recently'
  return {
    to,
    subject: `${context.firmName} - Inactivity Warning On Your Challenge`,
    html: htmlWrap(`Hi ${fullName}, your ${accountType} account is close to the inactivity limit.`, `
      <p>Your ${formatUsd(accountSize)} ${accountType} account has no recent trade activity.</p>
      <div style="background:#13253a;border:1px solid #1e2d3d;border-radius:8px;padding:16px 18px;margin:18px 0;">
        <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;">Last activity</p>
        <p style="margin:0 0 12px;color:#e8e0d0;font-weight:700;">${readableLastActivity}</p>
        <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;">Inactivity limit</p>
        <p style="margin:0;color:#e8e0d0;font-weight:700;">${inactivityFailDays} days</p>
      </div>
      <p>You have <strong style="color:#c9a84c;">${daysUntilFail} day${daysUntilFail === 1 ? '' : 's'}</strong> left before the inactivity auto-fail threshold is reached.</p>
      <p style="margin:24px 0;">
        <a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
          Resume Trading
        </a>
      </p>
    `),
    text: `Your ${accountType} challenge has ${daysUntilFail} day(s) left before the inactivity auto-fail threshold. Open ${context.baseUrl}/dashboard to resume trading.`
  }
}

function buildPhasePassedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const phase = String(payload?.phase || '').trim().toLowerCase()
  const accountSize = Number(payload?.accountSize || 0)
  const context = resolveMailContext()
  const isFunded = phase === 'phase2'
  const subject = isFunded
    ? `${context.firmName} - You're Now a Funded Trader!`
    : `${context.firmName} - Phase 1 Passed! Phase 2 Activated`
  const headline = isFunded
    ? `Congratulations ${fullName}! You've passed Phase 2.`
    : `Well done ${fullName}! You've passed Phase 1.`
  const body = isFunded
    ? `<p>Your $${accountSize.toLocaleString()} funded account is now active. You can start trading and requesting payouts at any time.</p>
       <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
       <p style="color:#888;font-size:13px;">Remember: 80% profit split, minimum payout $50, KYC required before first payout.</p>`
    : `<p>Phase 2 has been activated on your $${accountSize.toLocaleString()} account. Same rules apply: 10% profit target, 10% max drawdown, 30-day limit.</p>
       <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Start Phase 2</a></p>`

  return {
    to,
    subject,
    html: htmlWrap(headline, body),
    text: `${headline} Log in to continue.`
  }
}

function buildAccountFailedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const phase = String(payload?.phase || '').trim().toUpperCase()
  const reason = String(payload?.reason || 'Rule violation')
  const accountSize = Number(payload?.accountSize || 0)
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Challenge Account Failed`,
    html: htmlWrap(`Hi ${fullName}, your challenge account has been closed.`, `
      <p>Your ${phase} account ($${accountSize.toLocaleString()}) has been closed because:</p>
      <div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason}</div>
      <p>You can start a new challenge immediately.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Start New Challenge</a></p>
    `),
    text: `Your challenge was closed: ${reason}`
  }
}

function buildAccountExpiredEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const phase = String(payload?.phase || '').trim().toUpperCase()
  const accountSize = Number(payload?.accountSize || 0)
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Challenge Time Limit Reached`,
    html: htmlWrap(`Hi ${fullName}, your challenge time limit has been reached.`, `
      <p>Your ${phase} account ($${accountSize.toLocaleString()}) has expired because the 30-day time limit was reached before the profit target.</p>
      <p>You can start a new challenge right away.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Start New Challenge</a></p>
    `),
    text: `Your ${phase} challenge expired. Start a new one at ${context.baseUrl}/dashboard`
  }
}

function buildKycPendingReminderEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const hoursSinceSignup = Math.max(0, parseInt(payload?.hoursSinceSignup, 10) || 0)
  const daysSinceSignup = Math.max(1, Math.floor(hoursSinceSignup / 24) || 1)
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Complete Your KYC`,
    html: htmlWrap(`Hi ${fullName}, your verification is still incomplete.`, `
      <p>Your account was created ${daysSinceSignup} day${daysSinceSignup === 1 ? '' : 's'} ago, but your identity verification is still pending.</p>
      <p>Finishing KYC early keeps your account in a clean state and helps prevent payout delays later on.</p>
      <div style="background:#13253a;border:1px solid #1e2d3d;border-radius:8px;padding:16px 18px;margin:18px 0;">
        <p style="margin:0 0 8px;font-weight:700;color:#e8e0d0;">What to upload</p>
        <ul style="margin:0;padding-left:18px;color:#cbd5e1;">
          <li style="margin-bottom:6px;">Government-issued ID</li>
          <li style="margin-bottom:6px;">Clear selfie / face verification</li>
          <li>Any missing details requested in the portal</li>
        </ul>
      </div>
      <p style="margin:24px 0;">
        <a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
          Complete KYC
        </a>
      </p>
    `),
    text: `Your KYC is still incomplete. Log in at ${context.baseUrl}/dashboard to finish verification.`
  }
}

function buildKycApprovedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - KYC Verified`,
    html: htmlWrap(`Hi ${fullName}, your identity has been verified.`, `
      <p>Your KYC documents have been reviewed and approved. You can now trade and request payouts.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
    `),
    text: `KYC approved. You can now trade at ${context.baseUrl}/dashboard`
  }
}

function buildKycRejectedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const reason = String(payload?.reason || 'Documents did not meet verification requirements.')
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - KYC Verification Failed`,
    html: htmlWrap(`Hi ${fullName}, your KYC documents could not be verified.`, `
      <p>Your documents were reviewed but could not be approved for the following reason:</p>
      <div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason}</div>
      <p>Please log in and re-submit clear, valid government-issued documents.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Re-submit Documents</a></p>
    `),
    text: `KYC rejected: ${reason}. Please re-submit.`
  }
}

function buildPayoutRequestedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const amountRequested = Number(payload?.amountRequested || 0)
  const amountPayable = Number(payload?.amountPayable || 0)
  const paymentMethod = String(payload?.paymentMethod || 'your selected payment method')
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Payout Request Received`,
    html: htmlWrap(`Hi ${fullName}, your payout request is under review.`, `
      <p>We received your payout request for <strong style="color:#c9a84c;">${formatUsd(amountRequested)}</strong>.</p>
      <div style="background:#13253a;border:1px solid #1e2d3d;border-radius:8px;padding:16px 18px;margin:18px 0;">
        <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;">Payment method</p>
        <p style="margin:0 0 12px;color:#e8e0d0;font-weight:700;">${paymentMethod}</p>
        <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;">Estimated payable amount</p>
        <p style="margin:0;color:#e8e0d0;font-weight:700;">${formatUsd(amountPayable)}</p>
      </div>
      <p>Our team will review the request and update the status inside your payout history.</p>
      <p style="margin:24px 0;">
        <a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
          View Payout History
        </a>
      </p>
    `),
    text: `We received your payout request for ${formatUsd(amountRequested)} via ${paymentMethod}. Estimated payable amount: ${formatUsd(amountPayable)}.`
  }
}

function buildPayoutApprovedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const amountPayable = Number(payload?.amountPayable || 0)
  const paymentMethod = String(payload?.paymentMethod || 'selected payment method')
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Payout Approved`,
    html: htmlWrap(`Hi ${fullName}, your payout has been approved.`, `
      <p>Your payout of <strong style="color:#c9a84c;">${formatUsd(amountPayable)}</strong> via ${paymentMethod} has been approved and marked for payment.</p>
      <p style="color:#888;font-size:13px;">Processing time: up to 7 business days. Check your payment details for the transfer.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">View Payout History</a></p>
    `),
    text: `Payout of ${formatUsd(amountPayable)} approved via ${paymentMethod}.`
  }
}

function buildPayoutRejectedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const amountRequested = Number(payload?.amountRequested || 0)
  const reason = payload?.reason ? String(payload.reason) : ''
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Payout Request Declined`,
    html: htmlWrap(`Hi ${fullName}, your payout request could not be processed.`, `
      <p>Your payout request of <strong>$${amountRequested.toFixed(2)}</strong> was declined.</p>
      ${reason ? `<div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason}</div>` : ''}
      <p>If you believe this is an error, please contact support.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
    `),
    text: `Payout of $${amountRequested.toFixed(2)} declined.`
  }
}

function buildAffiliateCommissionEarnedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Affiliate')
  const commissionAmount = Number(payload?.commissionAmount || 0)
  const referredName = String(payload?.referredName || 'a trader you referred')
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - You Earned a Referral Commission`,
    html: htmlWrap(`Hi ${fullName}, you just earned a commission.`, `
      <p>${referredName} completed a paid challenge purchase, earning you a commission of <strong style="color:#c9a84c;">${formatUsd(commissionAmount)}</strong>.</p>
      <p>This has been added to your available affiliate balance.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">View Affiliate Dashboard</a></p>
    `),
    text: `You earned a referral commission of ${formatUsd(commissionAmount)} from ${referredName}.`
  }
}

function buildAffiliatePayoutRequestedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Affiliate')
  const amountRequested = Number(payload?.amountRequested || 0)
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Affiliate Payout Request Received`,
    html: htmlWrap(`Hi ${fullName}, your affiliate payout request is under review.`, `
      <p>We received your affiliate payout request for <strong style="color:#c9a84c;">${formatUsd(amountRequested)}</strong>.</p>
      <p>Our team will review the request and update the status inside your affiliate dashboard.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">View Affiliate Dashboard</a></p>
    `),
    text: `We received your affiliate payout request for ${formatUsd(amountRequested)}.`
  }
}

function buildAffiliatePayoutApprovedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Affiliate')
  const amountPayable = Number(payload?.amountPayable || 0)
  const paymentMethod = String(payload?.paymentMethod || 'selected payment method')
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Affiliate Payout Approved`,
    html: htmlWrap(`Hi ${fullName}, your affiliate payout has been approved.`, `
      <p>Your affiliate payout of <strong style="color:#c9a84c;">${formatUsd(amountPayable)}</strong> via ${paymentMethod} has been approved and marked for payment.</p>
      <p style="color:#888;font-size:13px;">Processing time: up to 7 business days. Check your payment details for the transfer.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">View Affiliate Dashboard</a></p>
    `),
    text: `Affiliate payout of ${formatUsd(amountPayable)} approved via ${paymentMethod}.`
  }
}

function buildAffiliatePayoutRejectedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Affiliate')
  const amountRequested = Number(payload?.amountRequested || 0)
  const reason = payload?.reason ? String(payload.reason) : ''
  const context = resolveMailContext()
  return {
    to,
    subject: `${context.firmName} - Affiliate Payout Request Declined`,
    html: htmlWrap(`Hi ${fullName}, your affiliate payout request could not be processed.`, `
      <p>Your affiliate payout request of <strong>${formatUsd(amountRequested)}</strong> was declined.</p>
      ${reason ? `<div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason}</div>` : ''}
      <p>If you believe this is an error, please contact support.</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
    `),
    text: `Affiliate payout of ${formatUsd(amountRequested)} declined.`
  }
}

function buildCompetitionPrizeVoucherEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const competitionTitle = String(payload?.competitionTitle || 'the competition')
  const voucherCode = String(payload?.voucherCode || '')
  const accountSize = Number(payload?.accountSize || 0)
  const expiresAt = payload?.expiresAt ? new Date(payload.expiresAt) : null
  const context = resolveMailContext()
  const expiryText = expiresAt && !Number.isNaN(expiresAt.getTime())
    ? ` before ${expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
    : ''
  return {
    to,
    subject: `${context.firmName} - You Won a Free Challenge Account!`,
    html: htmlWrap(`Congratulations ${fullName}!`, `
      <p>You placed in <strong>${competitionTitle}</strong> and won a free <strong style="color:#c9a84c;">$${accountSize.toLocaleString()}</strong> challenge account.</p>
      <p>Redeem it at checkout with this code${expiryText}:</p>
      <p style="margin:24px 0;font-size:20px;font-weight:700;letter-spacing:0.08em;color:#c9a84c;">${voucherCode}</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Claim Your Prize</a></p>
    `),
    text: `You won a free $${accountSize.toLocaleString()} challenge account in ${competitionTitle}. Redeem code ${voucherCode} at checkout${expiryText}.`
  }
}

function buildGiftChallengeVoucherEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const purchaserName = String(payload?.purchaserName || 'A friend')
  const voucherCode = String(payload?.voucherCode || '')
  const accountSize = Number(payload?.accountSize || 0)
  const giftMessage = payload?.giftMessage ? String(payload.giftMessage) : ''
  const expiresAt = payload?.expiresAt ? new Date(payload.expiresAt) : null
  const context = resolveMailContext()
  const expiryText = expiresAt && !Number.isNaN(expiresAt.getTime())
    ? ` before ${expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
    : ''
  return {
    to,
    subject: `${context.firmName} - ${purchaserName} sent you a challenge account!`,
    html: htmlWrap(`Hi ${fullName}!`, `
      <p><strong>${purchaserName}</strong> sent you a free <strong style="color:#c9a84c;">$${accountSize.toLocaleString()}</strong> challenge account.</p>
      ${giftMessage ? `<div style="background:#0d1b2a;border-left:3px solid #c9a84c;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e5e5e5;font-size:14px;font-style:italic;">"${giftMessage}"</div>` : ''}
      <p>Redeem it at checkout with this code${expiryText}:</p>
      <p style="margin:24px 0;font-size:20px;font-weight:700;letter-spacing:0.08em;color:#c9a84c;">${voucherCode}</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/register?gift=${encodeURIComponent(voucherCode)}" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Claim Your Gift</a></p>
      <p style="font-size:12px;color:#8a8a8a;">Already have an account? Log in and enter this code at checkout instead.</p>
    `),
    text: `${purchaserName} sent you a free $${accountSize.toLocaleString()} challenge account. Redeem code ${voucherCode} at checkout${expiryText}.`
  }
}

function buildReferralSeasonPrizeVoucherEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const seasonTitle = String(payload?.seasonTitle || 'the referral season')
  const voucherCode = String(payload?.voucherCode || '')
  const accountSize = Number(payload?.accountSize || 0)
  const expiresAt = payload?.expiresAt ? new Date(payload.expiresAt) : null
  const context = resolveMailContext()
  const expiryText = expiresAt && !Number.isNaN(expiresAt.getTime())
    ? ` before ${expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
    : ''
  return {
    to,
    subject: `${context.firmName} - You Won the Referral Season!`,
    html: htmlWrap(`Congratulations ${fullName}!`, `
      <p>You placed in <strong>${seasonTitle}</strong> and won a free <strong style="color:#c9a84c;">$${accountSize.toLocaleString()}</strong> challenge account.</p>
      <p>Redeem it at checkout with this code${expiryText}:</p>
      <p style="margin:24px 0;font-size:20px;font-weight:700;letter-spacing:0.08em;color:#c9a84c;">${voucherCode}</p>
      <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Claim Your Prize</a></p>
    `),
    text: `You won a free $${accountSize.toLocaleString()} challenge account in ${seasonTitle}. Redeem code ${voucherCode} at checkout${expiryText}.`
  }
}

/**
 * Certificate award email — the only template that carries attachments.
 *
 * The queued job stores just the certificate's public_id, never a base64 PDF:
 * `email_jobs.payload_json` is JSONB and a megabyte of encoded PDF per row
 * would be both slow and unloggable. The certificate is fetched and rendered
 * here, at send time.
 *
 * The preview image is attached with a Content-ID and referenced as
 * `cid:certificate-preview` rather than linked from the server. Most mail
 * clients block remote images by default, so a hosted URL would leave the
 * single most celebratory email the platform sends looking blank.
 *
 * Rendering failure degrades to a link-only email rather than throwing — a
 * trader should still hear that they passed even if the renderer is broken.
 */
async function buildCertificateAwardedEmail(payload) {
  const to = String(payload?.toEmail || '').trim()
  const fullName = String(payload?.fullName || 'Trader')
  const title = String(payload?.title || 'Certificate of Achievement')
  const publicId = String(payload?.certificatePublicId || '')
  const context = resolveMailContext()
  const verifyUrl = `${context.baseUrl}/verify/${encodeURIComponent(publicId)}`
  const dashboardUrl = `${context.baseUrl}/dashboard/certificates`

  const attachments = []
  let previewBlock = ''

  try {
    const pool = require('./db')
    const { getByPublicId } = require('./services/certificateService')
    const { getTemplateById } = require('./services/certificateTemplateService')
    const { renderCertificatePng, renderCertificatePdf } = require('./services/certificateRenderer')

    const certificate = await getByPublicId(pool, publicId)
    if (certificate) {
      const template = certificate.template_id
        ? await getTemplateById(pool, certificate.template_id)
        : null

      const [preview, pdf] = await Promise.all([
        renderCertificatePng(certificate, template, { width: 900, brandName: context.firmName }),
        renderCertificatePdf(certificate, template, { brandName: context.firmName })
      ])

      attachments.push(
        { filename: `certificate-${publicId}.png`, content: preview, cid: 'certificate-preview', contentType: 'image/png' },
        { filename: `certificate-${publicId}.pdf`, content: pdf, contentType: 'application/pdf' }
      )
      previewBlock = '<p style="margin:24px 0;"><img src="cid:certificate-preview" alt="' +
        `${title}" style="width:100%;max-width:456px;border:1px solid #1e2d3d;" /></p>`
    }
  } catch (error) {
    console.error(`[mail] Could not render certificate ${publicId}, sending links only:`, error.message)
  }

  return {
    to,
    subject: `${context.firmName} - ${title}`,
    html: htmlWrap(`Congratulations ${fullName}!`, `
      <p>You have earned your <strong style="color:#c9a84c;">${title}</strong> certificate.</p>
      ${previewBlock}
      <p>It is attached as a PDF, and it is always available in your dashboard. Anyone can confirm it is genuine using the verification link or the QR code on the certificate itself.</p>
      <p style="margin:24px 0;">
        <a href="${dashboardUrl}" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">View &amp; Share</a>
      </p>
      <p style="font-size:13px;color:#aaa;">Certificate ID: <strong style="color:#c9a84c;">${publicId}</strong><br>
      Verify at <a href="${verifyUrl}" style="color:#c9a84c;">${verifyUrl}</a></p>
    `),
    text: `Congratulations ${fullName}! You have earned your ${title} certificate (ID ${publicId}).\n\n` +
      `View and share it: ${dashboardUrl}\nVerify it: ${verifyUrl}`,
    attachments
  }
}

// Async because buildCertificateAwardedEmail renders the certificate at send
// time. Both callers (sendWithTemplate here, processEmailJob in
// utils/emailQueue.js) were already inside async functions, so this is an
// `await` at two call sites and nothing else.
async function buildEmailMessage(templateKey, payload = {}) {
  const normalizedKey = String(templateKey || '').trim().toLowerCase()

  switch (normalizedKey) {
    case 'password_reset':
      return buildPasswordResetEmail(payload)
    case 'welcome_onboarding':
      return buildWelcomeOnboardingEmail(payload)
    case 'challenge_expiry_reminder':
      return buildChallengeExpiryReminderEmail(payload)
    case 'challenge_inactivity_reminder':
      return buildChallengeInactivityReminderEmail(payload)
    case 'phase_passed':
      return buildPhasePassedEmail(payload)
    case 'account_failed':
      return buildAccountFailedEmail(payload)
    case 'account_expired':
      return buildAccountExpiredEmail(payload)
    case 'kyc_pending_reminder':
      return buildKycPendingReminderEmail(payload)
    case 'kyc_approved':
      return buildKycApprovedEmail(payload)
    case 'kyc_rejected':
      return buildKycRejectedEmail(payload)
    case 'payout_requested':
      return buildPayoutRequestedEmail(payload)
    case 'payout_approved':
      return buildPayoutApprovedEmail(payload)
    case 'payout_rejected':
      return buildPayoutRejectedEmail(payload)
    case 'affiliate_commission_earned':
      return buildAffiliateCommissionEarnedEmail(payload)
    case 'affiliate_payout_requested':
      return buildAffiliatePayoutRequestedEmail(payload)
    case 'affiliate_payout_approved':
      return buildAffiliatePayoutApprovedEmail(payload)
    case 'affiliate_payout_rejected':
      return buildAffiliatePayoutRejectedEmail(payload)
    case 'competition_prize_voucher':
      return buildCompetitionPrizeVoucherEmail(payload)
    case 'gift_challenge_voucher':
      return buildGiftChallengeVoucherEmail(payload)
    case 'referral_season_prize_voucher':
      return buildReferralSeasonPrizeVoucherEmail(payload)
    case 'certificate_awarded':
      return buildCertificateAwardedEmail(payload)
    default:
      throw new Error(`Unsupported email template: ${normalizedKey || 'unknown'}`)
  }
}

async function sendEmailMessage(message) {
  try {
    const context = resolveMailContext()
    const mailer = await getMailTransporter()
    // `attachments` was previously omitted here, so any template that built
    // one had it silently discarded before nodemailer ever saw it. The
    // certificate email is the first template to need attachments, and this one
    // line is what makes them actually send.
    const info = await mailer.sendMail({
      from: `"${context.fromName}" <${context.fromEmail}>`,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(Array.isArray(message.attachments) && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {})
    })
    let previewUrl = nodemailer.getTestMessageUrl(info) || null
    if (!previewUrl && info?.message) {
      const previewsDir = path.resolve(__dirname, 'logs', 'email-previews')
      fs.mkdirSync(previewsDir, { recursive: true })
      const safeMessageId = String(info.messageId || `${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, '_')
      const previewPath = path.join(previewsDir, `${safeMessageId}.json`)
      const previewBody = typeof info.message === 'string' ? info.message : JSON.stringify(info.message, null, 2)
      fs.writeFileSync(previewPath, previewBody, 'utf8')
      previewUrl = previewPath
    }
    if (previewUrl) console.log(`[mail] Preview: ${previewUrl}`)
    return {
      ok: true,
      messageId: info.messageId || null,
      previewUrl
    }
  } catch (err) {
    console.error(`[mail] Failed to send "${message.subject}" to ${message.to}:`, err.message)
    return {
      ok: false,
      error: err
    }
  }
}

async function sendWithTemplate(templateKey, payload = {}) {
  // The third `options` argument this used to forward was accepted by neither
  // buildEmailMessage nor sendEmailMessage — it was silently discarded, so it
  // is dropped rather than propagated.
  const message = await buildEmailMessage(templateKey, payload)
  const result = await sendEmailMessage(message)
  return result.ok
}

async function sendPasswordReset(toEmail, resetLink, resetToken, options = {}) {
  return sendWithTemplate('password_reset', { toEmail, resetLink, resetToken }, options)
}

async function sendWelcomeOnboardingEmail(toEmail, fullName, traderUid, affiliateCode, options = {}) {
  return sendWithTemplate('welcome_onboarding', { toEmail, fullName, traderUid, affiliateCode }, options)
}

async function sendChallengeExpiryReminderEmail(toEmail, fullName, accountType, accountSize, daysRemaining, phaseEndDate, options = {}) {
  return sendWithTemplate('challenge_expiry_reminder', { toEmail, fullName, accountType, accountSize, daysRemaining, phaseEndDate }, options)
}

async function sendChallengeInactivityReminderEmail(toEmail, fullName, accountType, accountSize, inactivityFailDays, daysUntilFail, lastActivityAt, options = {}) {
  return sendWithTemplate('challenge_inactivity_reminder', { toEmail, fullName, accountType, accountSize, inactivityFailDays, daysUntilFail, lastActivityAt }, options)
}

async function sendPhasePassedEmail(toEmail, fullName, phase, accountSize, options = {}) {
  return sendWithTemplate('phase_passed', { toEmail, fullName, phase, accountSize }, options)
}

async function sendAccountFailedEmail(toEmail, fullName, phase, reason, accountSize, options = {}) {
  return sendWithTemplate('account_failed', { toEmail, fullName, phase, reason, accountSize }, options)
}

async function sendAccountExpiredEmail(toEmail, fullName, phase, accountSize, options = {}) {
  return sendWithTemplate('account_expired', { toEmail, fullName, phase, accountSize }, options)
}

async function sendKycPendingReminderEmail(toEmail, fullName, hoursSinceSignup, options = {}) {
  return sendWithTemplate('kyc_pending_reminder', { toEmail, fullName, hoursSinceSignup }, options)
}

async function sendKycApprovedEmail(toEmail, fullName, options = {}) {
  return sendWithTemplate('kyc_approved', { toEmail, fullName }, options)
}

async function sendKycRejectedEmail(toEmail, fullName, reason, options = {}) {
  return sendWithTemplate('kyc_rejected', { toEmail, fullName, reason }, options)
}

async function sendPayoutRequestedEmail(toEmail, fullName, amountRequested, amountPayable, paymentMethod, options = {}) {
  return sendWithTemplate('payout_requested', { toEmail, fullName, amountRequested, amountPayable, paymentMethod }, options)
}

async function sendPayoutApprovedEmail(toEmail, fullName, amountPayable, paymentMethod, options = {}) {
  return sendWithTemplate('payout_approved', { toEmail, fullName, amountPayable, paymentMethod }, options)
}

async function sendPayoutRejectedEmail(toEmail, fullName, amountRequested, reason, options = {}) {
  return sendWithTemplate('payout_rejected', { toEmail, fullName, amountRequested, reason }, options)
}

async function sendAffiliateCommissionEarnedEmail(toEmail, fullName, commissionAmount, referredName, options = {}) {
  return sendWithTemplate('affiliate_commission_earned', { toEmail, fullName, commissionAmount, referredName }, options)
}

async function sendAffiliatePayoutRequestedEmail(toEmail, fullName, amountRequested, options = {}) {
  return sendWithTemplate('affiliate_payout_requested', { toEmail, fullName, amountRequested }, options)
}

async function sendAffiliatePayoutApprovedEmail(toEmail, fullName, amountPayable, paymentMethod, options = {}) {
  return sendWithTemplate('affiliate_payout_approved', { toEmail, fullName, amountPayable, paymentMethod }, options)
}

async function sendCompetitionPrizeVoucherEmail(toEmail, fullName, competitionTitle, voucherCode, accountSize, expiresAt, options = {}) {
  return sendWithTemplate('competition_prize_voucher', { toEmail, fullName, competitionTitle, voucherCode, accountSize, expiresAt }, options)
}

async function sendAffiliatePayoutRejectedEmail(toEmail, fullName, amountRequested, reason, options = {}) {
  return sendWithTemplate('affiliate_payout_rejected', { toEmail, fullName, amountRequested, reason }, options)
}

async function sendGiftChallengeVoucherEmail(toEmail, fullName, purchaserName, voucherCode, accountSize, giftMessage, expiresAt, options = {}) {
  return sendWithTemplate('gift_challenge_voucher', { toEmail, fullName, purchaserName, voucherCode, accountSize, giftMessage, expiresAt }, options)
}

async function sendReferralSeasonPrizeVoucherEmail(toEmail, fullName, seasonTitle, voucherCode, accountSize, expiresAt, options = {}) {
  return sendWithTemplate('referral_season_prize_voucher', { toEmail, fullName, seasonTitle, voucherCode, accountSize, expiresAt }, options)
}

module.exports = {
  EMAIL_TEMPLATE_KEYS,
  getMailTransporter,
  resolveMailTransportConfig,
  verifyMailTransportConnection,
  resolveMailContext,
  htmlWrap,
  isSupportedEmailTemplate,
  buildEmailMessage,
  sendEmailMessage,
  sendWithTemplate,
  sendPasswordReset,
  sendWelcomeOnboardingEmail,
  sendChallengeExpiryReminderEmail,
  sendChallengeInactivityReminderEmail,
  sendPhasePassedEmail,
  sendAccountFailedEmail,
  sendAccountExpiredEmail,
  sendKycPendingReminderEmail,
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendPayoutRequestedEmail,
  sendPayoutApprovedEmail,
  sendPayoutRejectedEmail,
  sendAffiliateCommissionEarnedEmail,
  sendAffiliatePayoutRequestedEmail,
  sendAffiliatePayoutApprovedEmail,
  sendAffiliatePayoutRejectedEmail,
  sendCompetitionPrizeVoucherEmail,
  sendGiftChallengeVoucherEmail,
  sendReferralSeasonPrizeVoucherEmail,
  hasConfiguredSendGridKey,
  __resetMailTransporterForTests() {
    transporter = null
  }
}
