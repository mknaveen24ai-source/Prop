// ─────────────────────────────────────────────────────────────────────────────
// mailer.js — Shared email service
// Used by: auth.js, challengeEngine.js, kyc.js (admin), payouts.js (admin)
//
// All emails are non-fatal — a send failure never crashes the originating request.
// In dev without SMTP configured, falls back to Ethereal (free test inbox).
// Preview URLs are logged to console so you can inspect emails at ethereal.email
// ─────────────────────────────────────────────────────────────────────────────

const nodemailer = require('nodemailer')
require('dotenv').config()

let transporter = null

async function getMailTransporter() {
  if (transporter) return transporter

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
    console.log(`[mail] SMTP: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`)
  } else {
    const testAccount = await nodemailer.createTestAccount()
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email', port: 587, secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    })
    console.warn('[mail] No SMTP — using Ethereal. View at https://ethereal.email')
  }
  return transporter
}

const FIRM = () => process.env.FIRM_NAME || 'Prop Firm'
const FROM = () => process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@propfirm.com'
const BASE_URL = () => process.env.FRONTEND_URL || 'http://localhost:3000'

// ── Shared HTML wrapper ────────────────────────────────────────────────────────
function htmlWrap(title, body) {
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#0d1b2a;color:#e8e0d0;border-radius:8px;">
      <h2 style="color:#c9a84c;font-family:serif;margin-bottom:4px;">${FIRM()}</h2>
      <p style="color:#aaa;margin-bottom:24px;font-size:14px;">${title}</p>
      ${body}
      <hr style="border:none;border-top:1px solid #1e2d3d;margin:28px 0;">
      <p style="color:#555;font-size:12px;">${FIRM()} · Simulated Trading Platform · <a href="${BASE_URL()}" style="color:#c9a84c;">Visit Platform</a></p>
    </div>
  `
}

async function send(to, subject, html, text) {
  try {
    const mailer = await getMailTransporter()
    const info = await mailer.sendMail({
      from: `"${FIRM()}" <${FROM()}>`,
      to, subject, html, text
    })
    const preview = nodemailer.getTestMessageUrl(info)
    if (preview) console.log(`[mail] Preview: ${preview}`)
    return true
  } catch (err) {
    console.error(`[mail] Failed to send "${subject}" to ${to}:`, err.message)
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD RESET
// ─────────────────────────────────────────────────────────────────────────────
async function sendPasswordReset(toEmail, resetLink) {
  const subject = `${FIRM()} — Password Reset Request`
  const html = htmlWrap('Password Reset Request', `
    <p>You requested a password reset. Click the button below to set a new password.</p>
    <p style="margin:28px 0;">
      <a href="${resetLink}" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
        Reset My Password
      </a>
    </p>
    <p style="color:#888;font-size:13px;">This link expires in <strong>1 hour</strong>. If you did not request this, ignore this email.</p>
  `)
  return send(toEmail, subject, html, `Reset your password: ${resetLink}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE PASSED (Phase 1 or Phase 2)
// ─────────────────────────────────────────────────────────────────────────────
async function sendPhasePassedEmail(toEmail, fullName, phase, accountSize) {
  const isFunded = phase === 'phase2'
  const subject  = isFunded
    ? `🎉 ${FIRM()} — You're Now a Funded Trader!`
    : `🏆 ${FIRM()} — Phase 1 Passed! Phase 2 Activated`

  const headline = isFunded
    ? `Congratulations ${fullName}! You've passed Phase 2.`
    : `Well done ${fullName}! You've passed Phase 1.`

  const body = isFunded
    ? `<p>Your $${Number(accountSize).toLocaleString()} funded account is now active. You can start trading and requesting payouts at any time.</p>
       <p style="margin:24px 0;"><a href="${BASE_URL()}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
       <p style="color:#888;font-size:13px;">Remember: 80% profit split, minimum payout $50, KYC required before first payout.</p>`
    : `<p>Phase 2 has been activated on your $${Number(accountSize).toLocaleString()} account. Same rules apply: 10% profit target, 10% max drawdown, 30-day limit.</p>
       <p style="margin:24px 0;"><a href="${BASE_URL()}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Start Phase 2</a></p>`

  return send(toEmail, subject, htmlWrap(headline, body), `${headline} Log in to continue.`)
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT FAILED
// ─────────────────────────────────────────────────────────────────────────────
async function sendAccountFailedEmail(toEmail, fullName, phase, reason, accountSize) {
  const subject = `${FIRM()} — Challenge Account Failed`
  const html = htmlWrap(`Hi ${fullName}, your challenge account has been closed.`, `
    <p>Your ${phase.toUpperCase()} account ($${Number(accountSize).toLocaleString()}) has been closed because:</p>
    <div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason}</div>
    <p>Since our challenge is free, you can start a new one immediately.</p>
    <p style="margin:24px 0;"><a href="${BASE_URL()}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Start New Challenge</a></p>
  `)
  return send(toEmail, subject, html, `Your challenge was closed: ${reason}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT EXPIRED
// ─────────────────────────────────────────────────────────────────────────────
async function sendAccountExpiredEmail(toEmail, fullName, phase, accountSize) {
  const subject = `${FIRM()} — Challenge Time Limit Reached`
  const html = htmlWrap(`Hi ${fullName}, your challenge time limit has been reached.`, `
    <p>Your ${phase.toUpperCase()} account ($${Number(accountSize).toLocaleString()}) has expired because the 30-day time limit was reached before the profit target.</p>
    <p>Since our challenge is free, you can start fresh right away.</p>
    <p style="margin:24px 0;"><a href="${BASE_URL()}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Start New Challenge</a></p>
  `)
  return send(toEmail, subject, html, `Your ${phase} challenge expired. Start a new one at ${BASE_URL()}/dashboard`)
}

// ─────────────────────────────────────────────────────────────────────────────
// KYC APPROVED
// ─────────────────────────────────────────────────────────────────────────────
async function sendKycApprovedEmail(toEmail, fullName) {
  const subject = `${FIRM()} — KYC Verified ✅`
  const html = htmlWrap(`Hi ${fullName}, your identity has been verified.`, `
    <p>Your KYC documents have been reviewed and approved. You can now trade and request payouts.</p>
    <p style="margin:24px 0;"><a href="${BASE_URL()}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
  `)
  return send(toEmail, subject, html, `KYC approved. You can now trade at ${BASE_URL()}/dashboard`)
}

// ─────────────────────────────────────────────────────────────────────────────
// KYC REJECTED
// ─────────────────────────────────────────────────────────────────────────────
async function sendKycRejectedEmail(toEmail, fullName, reason) {
  const subject = `${FIRM()} — KYC Verification Failed`
  const html = htmlWrap(`Hi ${fullName}, your KYC documents could not be verified.`, `
    <p>Your documents were reviewed but could not be approved for the following reason:</p>
    <div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason || 'Documents did not meet verification requirements.'}</div>
    <p>Please log in and re-submit clear, valid government-issued documents.</p>
    <p style="margin:24px 0;"><a href="${BASE_URL()}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Re-submit Documents</a></p>
  `)
  return send(toEmail, subject, html, `KYC rejected: ${reason}. Please re-submit.`)
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYOUT APPROVED
// ─────────────────────────────────────────────────────────────────────────────
async function sendPayoutApprovedEmail(toEmail, fullName, amountPayable, paymentMethod) {
  const subject = `${FIRM()} — Payout Approved 💰`
  const html = htmlWrap(`Hi ${fullName}, your payout has been approved.`, `
    <p>Your payout of <strong style="color:#c9a84c;">$${parseFloat(amountPayable).toFixed(2)}</strong> via ${paymentMethod} has been approved and is being processed.</p>
    <p style="color:#888;font-size:13px;">Processing time: up to 7 business days. Check your payment details for the transfer.</p>
    <p style="margin:24px 0;"><a href="${BASE_URL()}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">View Payout History</a></p>
  `)
  return send(toEmail, subject, html, `Payout of $${amountPayable} approved via ${paymentMethod}.`)
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYOUT REJECTED
// ─────────────────────────────────────────────────────────────────────────────
async function sendPayoutRejectedEmail(toEmail, fullName, amountRequested, reason) {
  const subject = `${FIRM()} — Payout Request Declined`
  const html = htmlWrap(`Hi ${fullName}, your payout request could not be processed.`, `
    <p>Your payout request of <strong>$${parseFloat(amountRequested).toFixed(2)}</strong> was declined.</p>
    ${reason ? `<div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason}</div>` : ''}
    <p>If you believe this is an error, please contact support.</p>
    <p style="margin:24px 0;"><a href="${BASE_URL()}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
  `)
  return send(toEmail, subject, html, `Payout of $${amountRequested} declined.`)
}

module.exports = {
  sendPasswordReset,
  sendPhasePassedEmail,
  sendAccountFailedEmail,
  sendAccountExpiredEmail,
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendPayoutApprovedEmail,
  sendPayoutRejectedEmail
}