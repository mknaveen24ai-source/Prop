const nodemailer = require('nodemailer')
require('./loadEnv')

let transporter = null

async function getMailTransporter() {
  if (transporter) return transporter

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
    console.log(`[mail] SMTP: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`)
  } else {
    const testAccount = await nodemailer.createTestAccount()
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass }
    })
    console.warn('[mail] No SMTP configured, using Ethereal preview inbox.')
  }
  return transporter
}

function resolveMailContext(tenant = null) {
  const firmName = tenant?.name || tenant?.logo_text || process.env.FIRM_NAME || process.env.PLATFORM_NAME || 'Prop Firm'
  const fromName = tenant?.email_from_name || firmName
  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || tenant?.support_email || 'noreply@propfirm.com'
  const baseUrl = tenant?.primary_domain
    ? `https://${tenant.primary_domain}`
    : (process.env.FRONTEND_URL || 'http://localhost:3000')

  return {
    firmName,
    fromName,
    fromEmail,
    baseUrl
  }
}

function htmlWrap(title, body, tenant = null) {
  const context = resolveMailContext(tenant)
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#0d1b2a;color:#e8e0d0;border-radius:8px;">
      <h2 style="color:#c9a84c;font-family:serif;margin-bottom:4px;">${context.firmName}</h2>
      <p style="color:#aaa;margin-bottom:24px;font-size:14px;">${title}</p>
      ${body}
      <hr style="border:none;border-top:1px solid #1e2d3d;margin:28px 0;">
      <p style="color:#555;font-size:12px;">
        ${context.firmName} · Simulated Trading Platform ·
        <a href="${context.baseUrl}" style="color:#c9a84c;">Visit Platform</a>
      </p>
    </div>
  `
}

async function send(to, subject, html, text, tenant = null) {
  try {
    const context = resolveMailContext(tenant)
    const mailer = await getMailTransporter()
    const info = await mailer.sendMail({
      from: `"${context.fromName}" <${context.fromEmail}>`,
      to,
      subject,
      html,
      text
    })
    const preview = nodemailer.getTestMessageUrl(info)
    if (preview) console.log(`[mail] Preview: ${preview}`)
    return true
  } catch (err) {
    console.error(`[mail] Failed to send "${subject}" to ${to}:`, err.message)
    return false
  }
}

async function sendPasswordReset(toEmail, resetLink, resetToken, options = {}) {
  const tenant = options?.tenant || null
  const context = resolveMailContext(tenant)
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
  `, tenant)

  return send(
    toEmail,
    subject,
    html,
    `Reset your password: ${resetLink}${resetToken ? ` (Code: ${resetToken})` : ''}`,
    tenant
  )
}

async function sendPhasePassedEmail(toEmail, fullName, phase, accountSize, options = {}) {
  const tenant = options?.tenant || null
  const context = resolveMailContext(tenant)
  const isFunded = phase === 'phase2'
  const subject = isFunded
    ? `${context.firmName} - You're Now a Funded Trader!`
    : `${context.firmName} - Phase 1 Passed! Phase 2 Activated`

  const headline = isFunded
    ? `Congratulations ${fullName}! You've passed Phase 2.`
    : `Well done ${fullName}! You've passed Phase 1.`

  const body = isFunded
    ? `<p>Your $${Number(accountSize).toLocaleString()} funded account is now active. You can start trading and requesting payouts at any time.</p>
       <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
       <p style="color:#888;font-size:13px;">Remember: 80% profit split, minimum payout $50, KYC required before first payout.</p>`
    : `<p>Phase 2 has been activated on your $${Number(accountSize).toLocaleString()} account. Same rules apply: 10% profit target, 10% max drawdown, 30-day limit.</p>
       <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Start Phase 2</a></p>`

  return send(toEmail, subject, htmlWrap(headline, body, tenant), `${headline} Log in to continue.`, tenant)
}

async function sendAccountFailedEmail(toEmail, fullName, phase, reason, accountSize, options = {}) {
  const tenant = options?.tenant || null
  const context = resolveMailContext(tenant)
  const subject = `${context.firmName} - Challenge Account Failed`
  const html = htmlWrap(`Hi ${fullName}, your challenge account has been closed.`, `
    <p>Your ${phase.toUpperCase()} account ($${Number(accountSize).toLocaleString()}) has been closed because:</p>
    <div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason}</div>
    <p>Since our challenge is free, you can start a new one immediately.</p>
    <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Start New Challenge</a></p>
  `, tenant)
  return send(toEmail, subject, html, `Your challenge was closed: ${reason}`, tenant)
}

async function sendAccountExpiredEmail(toEmail, fullName, phase, accountSize, options = {}) {
  const tenant = options?.tenant || null
  const context = resolveMailContext(tenant)
  const subject = `${context.firmName} - Challenge Time Limit Reached`
  const html = htmlWrap(`Hi ${fullName}, your challenge time limit has been reached.`, `
    <p>Your ${phase.toUpperCase()} account ($${Number(accountSize).toLocaleString()}) has expired because the 30-day time limit was reached before the profit target.</p>
    <p>Since our challenge is free, you can start fresh right away.</p>
    <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Start New Challenge</a></p>
  `, tenant)
  return send(toEmail, subject, html, `Your ${phase} challenge expired. Start a new one at ${context.baseUrl}/dashboard`, tenant)
}

async function sendKycApprovedEmail(toEmail, fullName, options = {}) {
  const tenant = options?.tenant || null
  const context = resolveMailContext(tenant)
  const subject = `${context.firmName} - KYC Verified`
  const html = htmlWrap(`Hi ${fullName}, your identity has been verified.`, `
    <p>Your KYC documents have been reviewed and approved. You can now trade and request payouts.</p>
    <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
  `, tenant)
  return send(toEmail, subject, html, `KYC approved. You can now trade at ${context.baseUrl}/dashboard`, tenant)
}

async function sendKycRejectedEmail(toEmail, fullName, reason, options = {}) {
  const tenant = options?.tenant || null
  const context = resolveMailContext(tenant)
  const subject = `${context.firmName} - KYC Verification Failed`
  const html = htmlWrap(`Hi ${fullName}, your KYC documents could not be verified.`, `
    <p>Your documents were reviewed but could not be approved for the following reason:</p>
    <div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason || 'Documents did not meet verification requirements.'}</div>
    <p>Please log in and re-submit clear, valid government-issued documents.</p>
    <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Re-submit Documents</a></p>
  `, tenant)
  return send(toEmail, subject, html, `KYC rejected: ${reason || 'Documents did not meet verification requirements.'}. Please re-submit.`, tenant)
}

async function sendPayoutApprovedEmail(toEmail, fullName, amountPayable, paymentMethod, options = {}) {
  const tenant = options?.tenant || null
  const context = resolveMailContext(tenant)
  const subject = `${context.firmName} - Payout Approved`
  const html = htmlWrap(`Hi ${fullName}, your payout has been approved.`, `
    <p>Your payout of <strong style="color:#c9a84c;">$${parseFloat(amountPayable).toFixed(2)}</strong> via ${paymentMethod} has been approved and is being processed.</p>
    <p style="color:#888;font-size:13px;">Processing time: up to 7 business days. Check your payment details for the transfer.</p>
    <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">View Payout History</a></p>
  `, tenant)
  return send(toEmail, subject, html, `Payout of $${amountPayable} approved via ${paymentMethod}.`, tenant)
}

async function sendPayoutRejectedEmail(toEmail, fullName, amountRequested, reason, options = {}) {
  const tenant = options?.tenant || null
  const context = resolveMailContext(tenant)
  const subject = `${context.firmName} - Payout Request Declined`
  const html = htmlWrap(`Hi ${fullName}, your payout request could not be processed.`, `
    <p>Your payout request of <strong>$${parseFloat(amountRequested).toFixed(2)}</strong> was declined.</p>
    ${reason ? `<div style="background:#1a0a0a;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin:16px 0;color:#e74c3c;font-size:14px;">${reason}</div>` : ''}
    <p>If you believe this is an error, please contact support.</p>
    <p style="margin:24px 0;"><a href="${context.baseUrl}/dashboard" style="background:#c9a84c;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">Go to Dashboard</a></p>
  `, tenant)
  return send(toEmail, subject, html, `Payout of $${amountRequested} declined.`, tenant)
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
