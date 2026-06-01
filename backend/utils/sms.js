/**
 * SMS Utility
 *
 * Supports two providers:
 *   - mock  (default) – logs the OTP to the console; FREE, no external service needed.
 *   - twilio          – sends a real SMS via Twilio Verify or Messages API.
 *
 * Set SMS_PROVIDER=twilio in .env for production.
 */

const logger = require('./logger')

/**
 * Send an SMS message.
 * @param {{ to: string, body: string }} opts
 * @returns {Promise<{ success: boolean, provider: string }>}
 */
async function sendSMS({ to, body }) {
  const provider = (process.env.SMS_PROVIDER || 'mock').toLowerCase()

  // ── Mock provider (development / staging) ────────────────────────────────
  if (provider === 'mock') {
    logger.info(`[SMS MOCK] To: ${to} | Message: ${body}`)
    // Also print to stdout so it is visible in the dev terminal
    console.log(`\n📱 [SMS MOCK] → ${to}\n   ${body}\n`)
    return { success: true, provider: 'mock' }
  }

  // ── Twilio provider ───────────────────────────────────────────────────────
  if (provider === 'twilio') {
    const accountSid   = process.env.TWILIO_ACCOUNT_SID
    const authToken    = process.env.TWILIO_AUTH_TOKEN
    const fromNumber   = process.env.TWILIO_PHONE_NUMBER

    if (!accountSid || !authToken || !fromNumber) {
      throw new Error(
        'Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in .env'
      )
    }

    // Lazy-require so Twilio package is only needed when actually used
    const twilio = require('twilio')
    const client = twilio(accountSid, authToken)

    const message = await client.messages.create({
      body,
      from: fromNumber,
      to
    })

    logger.info(`[SMS TWILIO] Sent to ${to} | SID: ${message.sid}`)
    return { success: true, provider: 'twilio', messageSid: message.sid }
  }

  throw new Error(`Unknown SMS_PROVIDER: "${provider}". Valid values: mock, twilio`)
}

module.exports = { sendSMS }
