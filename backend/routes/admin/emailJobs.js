// Admin email job queue listing and retry.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.
const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
const {
  ensureEmailQueueInfrastructure
} = require('../../utils/emailQueue')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  wantsAdminListContract, parseListPaging
} = require('./shared/helpers')

const { buildEmailJobListResult } = require('./shared/emailJobList')

router.get('/email-jobs', authenticateAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    await ensureEmailQueueInfrastructure()
    const paging = parseListPaging(req)
    const listResult = await buildEmailJobListResult({
      query: {
        page: paging.page,
        pageSize: paging.pageSize,
        search: req.query.search || '',
        sort: req.query.sort || 'created_at',
        order: req.query.order || 'desc',
        filters: {
          status: req.query.status || null,
          template_key: req.query.template_key || null,
          delivery_type: req.query.delivery_type || null
        }
      }
    })
    res.json(wantsAdminListContract(req) ? listResult : {
      summary: listResult.summary,
      rows: listResult.rows
    })
  } catch (error) {
    logger.error('Admin email jobs fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch email jobs' })
  }
})

router.post('/email-jobs/:jobId/retry', authenticateAdmin, async function(req, res) {
  try {
    await ensureEmailQueueInfrastructure()
    const jobId = parseInt(req.params.jobId, 10)
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ error: 'Valid email job id is required' })
    }

    const lookup = await pool.query(
      `SELECT id, status
         FROM email_jobs
        WHERE id = $1
        LIMIT 1`,
      [jobId]
    )
    if (lookup.rows.length === 0) {
      return res.status(404).json({ error: 'Email job not found' })
    }

    const status = String(lookup.rows[0].status || '').toLowerCase()
    if (!['retry', 'dead', 'failed'].includes(status)) {
      return res.status(409).json({ error: 'Only retryable email jobs can be re-queued' })
    }

    await pool.query(
      `UPDATE email_jobs
          SET status = 'pending',
              scheduled_for = NOW(),
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [jobId]
    )

    res.json({ message: 'Email job re-queued', job_id: jobId })
  } catch (error) {
    logger.error('Admin email job retry error:', { error: error.message })
    res.status(500).json({ error: 'Could not re-queue email job' })
  }
})

module.exports = router
