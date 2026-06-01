const { isValidEmail, sanitizeString } = require('./validation')

const SUPPORT_CATEGORIES = Object.freeze([
  'account',
  'trading',
  'kyc',
  'payout',
  'technical',
  'other'
])

function normalizeSupportCategory(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return SUPPORT_CATEGORIES.includes(normalized) ? normalized : 'other'
}

function normalizeOptionalEmail(value) {
  const email = sanitizeString(String(value || ''), 254).toLowerCase()
  if (!email) return { email: null, error: null }
  if (!isValidEmail(email)) return { email: null, error: 'Email must be valid' }
  return { email, error: null }
}

function sanitizeLimited(value, maxLength) {
  return sanitizeString(String(value || ''), maxLength).slice(0, maxLength)
}

function normalizeSupportTicketPayload(body = {}, defaults = {}) {
  const subject = sanitizeLimited(body.subject, 160)
  const message = sanitizeLimited(body.message, 4000)
  const name = sanitizeLimited(body.name || defaults.name || '', 120) || null
  const { email, error: emailError } = normalizeOptionalEmail(body.email || defaults.email || '')
  const errors = []

  if (!subject) errors.push('Subject is required')
  if (!message) errors.push('Message is required')
  if (emailError) errors.push(emailError)

  return {
    value: {
      category: normalizeSupportCategory(body.category),
      subject,
      message,
      email,
      name
    },
    errors
  }
}

function normalizeSupportReplyPayload(body = {}) {
  const message = sanitizeLimited(body.message, 2000)
  return {
    value: { message },
    errors: message ? [] : ['Reply message is required']
  }
}

module.exports = {
  SUPPORT_CATEGORIES,
  normalizeSupportCategory,
  normalizeSupportTicketPayload,
  normalizeSupportReplyPayload
}
