// Admin saved views, tags, notes, case linking and entity metadata.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const { adminDeleteLimiter } = require('./shared/rateLimiters')
const {
  authenticateAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  getAdminActorLabel
} = require('./shared/audit')
const {
  getAdminOwnerId, normalizeAdminTag, normalizeEntityType, upsertAdminEntityMeta,
  normalizeEntityId
} = require('./shared/helpers')

router.get('/saved-views', authenticateAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const resource = String(req.query?.resource || '').trim().toLowerCase()
    if (!resource) {
      return res.status(400).json({ error: 'resource is required' })
    }

    const adminId = getAdminOwnerId(req.admin)
    const result = await pool.query(
      `SELECT id, resource, name, config_json, is_default, created_at, updated_at
       FROM admin_saved_views
       WHERE admin_id = $1
         AND resource = $2
       ORDER BY is_default DESC, updated_at DESC, id DESC`,
      [adminId, resource]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Saved views fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not load saved views' })
  }
})

router.post('/saved-views', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const resource = String(req.body?.resource || '').trim().toLowerCase()
    const name = String(req.body?.name || '').trim()
    const config = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {}
    const isDefault = !!req.body?.is_default
    const adminId = getAdminOwnerId(req.admin)

    if (!resource) return res.status(400).json({ error: 'resource is required' })
    if (name.length < 2) return res.status(400).json({ error: 'name is required' })

    await client.query('BEGIN')
    if (isDefault) {
      await client.query(
        `UPDATE admin_saved_views
            SET is_default = FALSE, updated_at = NOW()
          WHERE admin_id = $1
            AND resource = $2`,
        [adminId, resource]
      )
    }

    const result = await client.query(
      `INSERT INTO admin_saved_views
        (admin_id, admin_role, resource, name, config_json, is_default, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW())
       RETURNING id, resource, name, config_json, is_default, created_at, updated_at`,
      [adminId, req.admin?.role || 'admin', resource, name.slice(0, 120), JSON.stringify(config), isDefault]
    )
    await client.query('COMMIT')
    res.status(201).json(result.rows[0])
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Saved view create error:', { error: error.message })
    res.status(500).json({ error: 'Could not save view' })
  } finally {
    client.release()
  }
})

router.patch('/saved-views/:id', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const adminId = getAdminOwnerId(req.admin)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Valid saved view id is required' })

    const existing = await client.query(
      `SELECT id, resource
       FROM admin_saved_views
       WHERE id = $1
         AND admin_id = $2`,
      [id, adminId]
    )
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Saved view not found' })

    const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 120) : null
    const config = req.body?.config && typeof req.body.config === 'object' ? req.body.config : null
    const isDefault = req.body?.is_default === undefined ? null : !!req.body.is_default

    await client.query('BEGIN')
    if (isDefault) {
      await client.query(
        `UPDATE admin_saved_views
            SET is_default = FALSE, updated_at = NOW()
          WHERE admin_id = $1
            AND resource = $2`,
        [adminId, existing.rows[0].resource]
      )
    }

    const result = await client.query(
      `UPDATE admin_saved_views
          SET name = COALESCE($1, name),
              config_json = COALESCE($2::jsonb, config_json),
              is_default = COALESCE($3, is_default),
              updated_at = NOW()
        WHERE id = $4
          AND admin_id = $5
        RETURNING id, resource, name, config_json, is_default, created_at, updated_at`,
      [name || null, config ? JSON.stringify(config) : null, isDefault, id, adminId]
    )
    await client.query('COMMIT')
    res.json(result.rows[0])
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Saved view update error:', { error: error.message })
    res.status(500).json({ error: 'Could not update saved view' })
  } finally {
    client.release()
  }
})

router.delete('/saved-views/:id', authenticateAdmin, adminDeleteLimiter, async function(req, res) {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const adminId = getAdminOwnerId(req.admin)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Valid saved view id is required' })

    const result = await pool.query(
      `DELETE FROM admin_saved_views
        WHERE id = $1
          AND admin_id = $2
      RETURNING id`,
      [id, adminId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Saved view not found' })
    res.json({ message: 'Saved view deleted' })
  } catch (error) {
    logger.error('Saved view delete error:', { error: error.message })
    res.status(500).json({ error: 'Could not delete saved view' })
  }
})

router.post('/tags/assign', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(normalizeEntityId).filter(Boolean).slice(0, 100) : []
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(normalizeAdminTag).filter(Boolean).slice(0, 20) : []
    const mode = String(req.body?.mode || 'add').trim().toLowerCase()
    const adminActor = getAdminActorLabel(req.admin)

    if (!entityType) return res.status(400).json({ error: 'Valid entity_type is required' })
    if (ids.length === 0) return res.status(400).json({ error: 'At least one entity id is required' })
    if (tags.length === 0 && mode !== 'clear') return res.status(400).json({ error: 'At least one tag is required' })
    if (!['add', 'remove', 'set', 'clear'].includes(mode)) return res.status(400).json({ error: 'mode must be add, remove, set, or clear' })

    await client.query('BEGIN')
    for (const entityId of ids) {
      if (mode === 'clear') {
        await client.query(
          `DELETE FROM admin_entity_tags
            WHERE entity_type = $1
              AND entity_id = $2`,
          [entityType, entityId]
        )
        continue
      }

      if (mode === 'set') {
        await client.query(
          `DELETE FROM admin_entity_tags
            WHERE entity_type = $1
              AND entity_id = $2
              AND tag <> ALL($3::text[])`,
          [entityType, entityId, tags]
        )
      }

      if (mode === 'remove') {
        await client.query(
          `DELETE FROM admin_entity_tags
            WHERE entity_type = $1
              AND entity_id = $2
              AND tag = ANY($3::text[])`,
          [entityType, entityId, tags]
        )
      } else {
        for (const tag of tags) {
          await client.query(
            `INSERT INTO admin_entity_tags (entity_type, entity_id, tag, created_by, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (entity_type, entity_id, tag) DO NOTHING`,
            [entityType, entityId, tag, adminActor]
          )
        }
      }
    }
    await client.query('COMMIT')
    res.json({ message: 'Tags updated', entity_type: entityType, ids, tags, mode })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Tag assignment error:', { error: error.message })
    res.status(500).json({ error: 'Could not update tags' })
  } finally {
    client.release()
  }
})

router.get('/notes', authenticateAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.query?.entity_type)
    const entityId = normalizeEntityId(req.query?.entity_id)
    if (!entityType || !entityId) {
      return res.status(400).json({ error: 'entity_type and entity_id are required' })
    }

    const result = await pool.query(
      `SELECT id, entity_type, entity_id, note_text, created_by, created_at
       FROM admin_entity_notes
       WHERE entity_type = $1
         AND entity_id = $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [entityType, entityId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Notes fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not load notes' })
  }
})

router.post('/notes', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const entityId = normalizeEntityId(req.body?.entity_id)
    const noteText = String(req.body?.note || '').trim()
    const createdBy = getAdminActorLabel(req.admin)

    if (!entityType || !entityId) return res.status(400).json({ error: 'Valid entity_type and entity_id are required' })
    if (noteText.length < 2) return res.status(400).json({ error: 'A note is required' })

    const result = await client.query(
      `INSERT INTO admin_entity_notes
        (entity_type, entity_id, note_text, created_by, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, entity_type, entity_id, note_text, created_by, created_at`,
      [entityType, entityId, noteText.slice(0, 4000), createdBy]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    logger.error('Note create error:', { error: error.message })
    res.status(500).json({ error: 'Could not add note' })
  } finally {
    client.release()
  }
})

router.post('/cases/link', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const entityId = normalizeEntityId(req.body?.entity_id)
    const caseId = req.body?.case_id == null || req.body?.case_id === '' ? null : parseInt(req.body.case_id, 10)

    if (!entityType || !entityId) return res.status(400).json({ error: 'Valid entity_type and entity_id are required' })
    if (caseId !== null) {
      const caseLookup = await client.query(`SELECT id FROM admin_cases WHERE id = $1`, [caseId])
      if (caseLookup.rows.length === 0) return res.status(404).json({ error: 'Case not found' })
    }

    const meta = await upsertAdminEntityMeta(client, {
      entityType,
      entityId,
      patch: { linked_case_id: caseId }
    })
    res.json({ message: caseId ? 'Case linked' : 'Case unlinked', meta })
  } catch (error) {
    logger.error('Case link error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not link case' })
  } finally {
    client.release()
  }
})

router.post('/entity-meta', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const entityId = normalizeEntityId(req.body?.entity_id)
    if (!entityType || !entityId) {
      return res.status(400).json({ error: 'Valid entity_type and entity_id are required' })
    }

    const patch = {
      owner_admin_id: req.body?.owner_admin_id ? String(req.body.owner_admin_id).trim().slice(0, 120) : null,
      priority: req.body?.priority ? String(req.body.priority).trim().toLowerCase() : null,
      workflow_status: req.body?.workflow_status ? String(req.body.workflow_status).trim().toLowerCase() : null,
      classification: req.body?.classification ? String(req.body.classification).trim().toLowerCase().slice(0, 120) : null,
      risk_tier: req.body?.risk_tier ? String(req.body.risk_tier).trim().toLowerCase() : null,
      status_reason: req.body?.status_reason ? String(req.body.status_reason).trim().slice(0, 1000) : null,
      sla_state: req.body?.sla_state ? String(req.body.sla_state).trim().toLowerCase().slice(0, 120) : null,
      linked_case_id: req.body?.linked_case_id ? parseInt(req.body.linked_case_id, 10) : null
    }

    const meta = await upsertAdminEntityMeta(client, { entityType, entityId, patch })
    res.json({ message: 'Entity metadata updated', meta })
  } catch (error) {
    logger.error('Entity meta update error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not update entity metadata' })
  } finally {
    client.release()
  }
})

module.exports = router
