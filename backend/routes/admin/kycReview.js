// Admin KYC SLA tracking and document quality flags.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin,
  requireAdminCapability
} = require('../middleware')
const fs = require('fs')
const path = require('path')
const {  getOriginalKycExtension } = require('../../utils/secureKycStorage')
require('../../loadEnv')

const {
  buildKycDocumentPresencePredicate
} = require('./shared/helpers')

router.get('/kyc-sla', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async (req, res) => {
  try {
    const slaHoursRaw = parseInt(req.query.sla_hours || '24', 10)
    const slaHours = Number.isFinite(slaHoursRaw) ? Math.max(1, Math.min(168, slaHoursRaw)) : 24

    const pending = await pool.query(
      `SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         COALESCE(NULLIF(TRIM(u.country), ''), 'UNKNOWN') AS country,
         COALESCE(u.kyc_submitted_at, u.created_at) AS submitted_at,
         EXTRACT(EPOCH FROM (NOW() - COALESCE(u.kyc_submitted_at, u.created_at))) / 3600.0 AS wait_hours,
         COUNT(a.id)::int AS accounts_total,
         COUNT(*) FILTER (WHERE a.account_type = 'funded')::int AS funded_accounts
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
       WHERE u.kyc_status = 'pending'
       GROUP BY u.id, u.full_name, u.email, u.country, u.kyc_submitted_at, u.created_at
       ORDER BY COALESCE(u.kyc_submitted_at, u.created_at) ASC
       LIMIT 600`
    )

    const queue = pending.rows.map(r => {
      const waitHours = parseFloat(r.wait_hours || 0)
      const sla_status =
        waitHours >= slaHours * 2 ? 'breach'
          : waitHours >= slaHours ? 'overdue'
            : waitHours >= slaHours * 0.6 ? 'warning'
              : 'within_sla'
      return {
        ...r,
        wait_hours: parseFloat(waitHours.toFixed(2)),
        wait_minutes: Math.max(0, Math.floor(waitHours * 60)),
        sla_status
      }
    })

    const pendingTotal = queue.length
    const overdueCount = queue.filter(r => r.sla_status === 'overdue' || r.sla_status === 'breach').length
    const breachCount = queue.filter(r => r.sla_status === 'breach').length
    const avgWaitHours = pendingTotal > 0
      ? parseFloat((queue.reduce((s, r) => s + (r.wait_hours || 0), 0) / pendingTotal).toFixed(2))
      : 0

    res.json({
      generated_at: new Date(),
      sla_hours: slaHours,
      summary: {
        pending_total: pendingTotal,
        overdue_total: overdueCount,
        breach_total: breachCount,
        avg_wait_hours: avgWaitHours
      },
      queue
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load KYC SLA queue' })
  }
})

router.get('/kyc-quality-flags', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async (req, res) => {
  try {
    const uploadsRoot = path.resolve(__dirname, '../uploads')
    const docs = await pool.query(
      `SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         u.kyc_status,
         COALESCE(u.kyc_submitted_at, u.created_at) AS submitted_at,
         u.id_document_path,
         u.id_document_back_path,
         u.selfie_path
       FROM users u
       WHERE ${buildKycDocumentPresencePredicate('u')}
       ORDER BY COALESCE(u.kyc_submitted_at, u.created_at) DESC
       LIMIT 500`
    )

    function inspectRelativeFile(relPath) {
      // getOriginalKycExtension strips a `.enc` at-rest-encryption suffix (if present)
      // before reading the extension, so encrypted and legacy plaintext files report
      // the same logical extension for the quality heuristics below.
      if (!relPath) return { exists: false, size_bytes: 0, ext: '' }
      const raw = String(relPath).replace(/^[/\\]+/, '')
      const safe = raw.replace(/\.\./g, '')
      const abs = path.resolve(uploadsRoot, safe)
      if (!abs.startsWith(uploadsRoot + path.sep) && abs !== uploadsRoot) {
        return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
      }
      try {
        if (!fs.existsSync(abs)) return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
        const st = fs.statSync(abs)
        return { exists: true, size_bytes: st.size, ext: getOriginalKycExtension(raw) }
      } catch {
        return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
      }
    }

    const rows = docs.rows.map(r => {
      const idFile = inspectRelativeFile(r.id_document_path)
      const idBackFile = inspectRelativeFile(r.id_document_back_path)
      const selfieFile = inspectRelativeFile(r.selfie_path)
      const flags = []
      let qualityScore = 0

      if (!idFile.exists) { flags.push('Missing ID document file'); qualityScore += 50 }
      if (!idBackFile.exists) { flags.push('Missing ID document back file'); qualityScore += 30 }
      if (!selfieFile.exists) { flags.push('Missing selfie file'); qualityScore += 50 }

      if (idFile.exists && !['.jpg', '.jpeg', '.png', '.pdf'].includes(idFile.ext)) {
        flags.push('Unexpected ID document extension')
        qualityScore += 20
      }
      if (selfieFile.exists && !['.jpg', '.jpeg', '.png'].includes(selfieFile.ext)) {
        flags.push('Unexpected selfie extension')
        qualityScore += 25
      }
      if (idFile.exists && idFile.ext !== '.pdf' && idFile.size_bytes < 70 * 1024) {
        flags.push('ID image file very small')
        qualityScore += 20
      }
      if (selfieFile.exists && selfieFile.size_bytes < 60 * 1024) {
        flags.push('Selfie file very small')
        qualityScore += 25
      }
      if (idFile.exists && selfieFile.exists && (idFile.size_bytes + selfieFile.size_bytes) < 180 * 1024) {
        flags.push('Combined KYC payload unusually small')
        qualityScore += 15
      }

      const submittedAt = r.submitted_at ? new Date(r.submitted_at) : null
      if (submittedAt && String(r.kyc_status || '') === 'pending') {
        const ageHours = (Date.now() - submittedAt.getTime()) / 3600000
        if (ageHours >= 48) {
          flags.push('Pending review for more than 48 hours')
          qualityScore += 10
        }
      }

      return {
        ...r,
        id_file_exists: idFile.exists,
        id_file_size: idFile.size_bytes,
        back_file_exists: idBackFile.exists,
        back_file_size: idBackFile.size_bytes,
        selfie_file_exists: selfieFile.exists,
        selfie_file_size: selfieFile.size_bytes,
        quality_score: qualityScore,
        risk_level: qualityScore >= 60 ? 'high' : qualityScore >= 30 ? 'medium' : 'low',
        flags
      }
    }).sort((a, b) => b.quality_score - a.quality_score)

    res.json({
      generated_at: new Date(),
      summary: {
        total_profiles: rows.length,
        high_risk_count: rows.filter(r => r.risk_level === 'high').length,
        medium_risk_count: rows.filter(r => r.risk_level === 'medium').length,
        missing_file_count: rows.filter(r => !r.id_file_exists || !r.back_file_exists || !r.selfie_file_exists).length
      },
      rows
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load KYC quality flags' })
  }
})

module.exports = router
