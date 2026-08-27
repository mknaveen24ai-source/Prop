const {
  resolveMailTransportConfig,
  verifyMailTransportConnection
} = require('../mailer')

function printConfig(config) {
  const lines = [
    `mode: ${config.mode}`,
    `provider: ${config.provider}`
  ]

  if (config.host) lines.push(`host: ${config.host}`)
  if (config.port) lines.push(`port: ${config.port}`)
  if (config.user) lines.push(`user: ${config.user}`)
  if (config.fromEmail) lines.push(`from: ${config.fromEmail}`)
  lines.push(`brevo: ${config.usesBrevo ? 'yes' : 'no'}`)

  console.log('[email:verify] Current transport')
  for (const line of lines) {
    console.log(`  - ${line}`)
  }
}

async function main() {
  const config = resolveMailTransportConfig()
  printConfig(config)

  if (config.mode === 'preview') {
    console.log('[email:verify] No real SMTP configured. The app will use local preview files in backend/logs/email-previews.')
    console.log('[email:verify] Recommended Brevo block:')
    console.log('  SMTP_HOST=smtp-relay.brevo.com')
    console.log('  SMTP_PORT=587')
    console.log('  SMTP_USER=<your-brevo-smtp-login>')
    console.log('  SMTP_PASS=<your-brevo-smtp-key>')
    console.log('  SMTP_FROM=support@yourdomain.com')
    return
  }

  try {
    const result = await verifyMailTransportConnection()
    if (result.skipped) {
      console.log(`[email:verify] Transport available, verification skipped (${result.reason}).`)
      return
    }
    console.log('[email:verify] SMTP verification succeeded.')
    if (result.config.usesBrevo) {
      console.log('[email:verify] Brevo SMTP is active and ready for the email worker.')
    }
  } catch (error) {
    console.error(`[email:verify] Verification failed: ${error.message}`)
    process.exitCode = 1
  }
}

main()
