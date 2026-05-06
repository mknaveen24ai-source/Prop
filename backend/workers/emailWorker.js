#!/usr/bin/env node

require('../loadEnv')

const logger = require('../utils/logger')
const pool = require('../db')
const {
  ensureEmailQueueInfrastructure,
  runEmailAutomationPass,
  processEmailQueueBatch
} = require('../utils/emailQueue')

const POLL_MS = Math.max(1000, parseInt(process.env.EMAIL_WORKER_POLL_MS || '5000', 10) || 5000)
const BATCH_SIZE = Math.max(1, Math.min(parseInt(process.env.EMAIL_WORKER_BATCH_SIZE || '10', 10) || 10, 100))
const AUTOMATION_SWEEP_MS = Math.max(60_000, parseInt(process.env.EMAIL_AUTOMATION_SWEEP_MS || `${15 * 60_000}`, 10) || (15 * 60_000))

let intervalHandle = null
let isShuttingDown = false
let inFlight = false
let lastAutomationSweepAt = 0

async function tick() {
  if (inFlight || isShuttingDown) return
  inFlight = true
  try {
    if ((Date.now() - lastAutomationSweepAt) >= AUTOMATION_SWEEP_MS) {
      const automationSummary = await runEmailAutomationPass()
      lastAutomationSweepAt = Date.now()
      if (automationSummary.scheduled > 0) {
        logger.info('[email-worker] Scheduled automation emails', automationSummary)
      }
    }

    const summary = await processEmailQueueBatch({ batchSize: BATCH_SIZE })
    if (summary.claimed > 0) {
      logger.info('[email-worker] Processed email batch', summary)
    }
  } catch (error) {
    logger.error('[email-worker] Batch processing failed', { error: error.message })
  } finally {
    inFlight = false
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  logger.info('[email-worker] Shutting down', { signal })
  await pool.end().catch(() => {})
  process.exit(0)
}

async function main() {
  await ensureEmailQueueInfrastructure()
  logger.info('[email-worker] Started', { poll_ms: POLL_MS, batch_size: BATCH_SIZE, automation_sweep_ms: AUTOMATION_SWEEP_MS })
  await tick()
  intervalHandle = setInterval(tick, POLL_MS)
}

process.once('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)) })
process.once('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })

main().catch((error) => {
  logger.error('[email-worker] Failed to start', { error: error.message })
  process.exit(1)
})
