process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-for-cert-integration'
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://propfirm.example.com'

const { Client } = require('pg')
const assert = require('node:assert/strict')

const certificates = require('../../services/certificateService')
const templates = require('../../services/certificateTemplateService')
const { verifyCertificateSignature } = require('../../utils/certificateSignature')
const { renderCertificatePng } = require('../../services/certificateRenderer')
const { normalizeLayout } = require('../../services/certificateLayout')

const results = []
function check(name, fn) {
  return (async () => {
    try { await fn(); results.push(['PASS', name]) }
    catch (error) { results.push(['FAIL', `${name} :: ${error.message}`]) }
  })()
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()

  // These assertions are about counts, versions and "is this the first
  // template" — so the suite has to start from a known state or it passes once
  // and then fails on every re-run. Scratch database only; run-all.js says so
  // and this refuses outright under NODE_ENV=production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to truncate certificate tables with NODE_ENV=production')
  }
  await db.query('TRUNCATE certificates, certificate_templates RESTART IDENTITY CASCADE')

  // A trader to hang certificates off.
  const user = await db.query(
    `INSERT INTO users (email, password_hash, full_name, country)
     VALUES ('cert-test@example.com', 'x', 'Alexandra Whitmore', 'GB')
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id, email, full_name`
  )
  const userId = user.rows[0].id

  await check('issue creates a certificate', async () => {
    const { certificate, created } = await certificates.issueCertificate(db, {
      userId, kind: 'funded', title: '$100,000 Funded Trader',
      recipientName: 'Alexandra Whitmore', amount: 100000,
      sourceKey: 'promotion:test-account-1'
    })
    assert.equal(created, true)
    assert.match(certificate.public_id, /^PF-\d{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    assert.equal(certificate.status, 'active')
    assert.equal(certificate.template_id, null, 'no template uploaded yet, so built-in')
  })

  // The signature is computed in JS but stored in Postgres, which hands back a
  // Date for timestamptz and a string for NUMERIC. If normalisation is wrong,
  // every certificate fails its own verification on the very next read.
  await check('signature survives a database round-trip', async () => {
    const row = await certificates.getByPublicId(db,
      (await db.query(`SELECT public_id FROM certificates WHERE source_key = 'promotion:test-account-1'`)).rows[0].public_id)
    assert.equal(typeof row.amount, 'string', 'NUMERIC comes back as a string')
    assert.ok(row.issued_at instanceof Date, 'timestamptz comes back as a Date')
    assert.equal(verifyCertificateSignature(row), true)
    assert.deepEqual(certificates.describeVerification(row), { valid: true, status: 'active', signatureValid: true })
  })

  await check('same sourceKey is idempotent', async () => {
    const before = await db.query(`SELECT COUNT(*)::int c FROM certificates WHERE source_key = 'promotion:test-account-1'`)
    const { created } = await certificates.issueCertificate(db, {
      userId, kind: 'funded', title: '$100,000 Funded Trader',
      recipientName: 'Alexandra Whitmore', amount: 100000,
      sourceKey: 'promotion:test-account-1'
    })
    const after = await db.query(`SELECT COUNT(*)::int c FROM certificates WHERE source_key = 'promotion:test-account-1'`)
    assert.equal(created, false, 'second issue must report created:false')
    assert.equal(after.rows[0].c, before.rows[0].c, 'no duplicate row')
    assert.equal(after.rows[0].c, 1)
  })

  await check('null sourceKey stays unconstrained (manual awards)', async () => {
    const a = await certificates.issueCertificate(db, { userId, kind: 'custom', title: 'Trader of the Month', recipientName: 'Alexandra Whitmore' })
    const b = await certificates.issueCertificate(db, { userId, kind: 'custom', title: 'Trader of the Month', recipientName: 'Alexandra Whitmore' })
    assert.equal(a.created, true)
    assert.equal(b.created, true)
    assert.notEqual(a.certificate.public_id, b.certificate.public_id)
  })

  await check('rollback leaves no certificate behind', async () => {
    await db.query('BEGIN')
    await certificates.issueCertificate(db, {
      userId, kind: 'payout', title: '$9,999 Profit Payout',
      recipientName: 'Alexandra Whitmore', amount: 9999,
      sourceKey: 'payout:rolled-back'
    })
    await db.query('ROLLBACK')
    const found = await db.query(`SELECT COUNT(*)::int c FROM certificates WHERE source_key = 'payout:rolled-back'`)
    assert.equal(found.rows[0].c, 0)
  })

  await check('tampering with the row is detected', async () => {
    const row = await certificates.getByPublicId(db,
      (await db.query(`SELECT public_id FROM certificates WHERE source_key = 'promotion:test-account-1'`)).rows[0].public_id)
    const tampered = { ...row, title: '$900,000 Funded Trader' }
    assert.equal(verifyCertificateSignature(tampered), false)
    assert.equal(certificates.describeVerification(tampered).status, 'tampered')
    assert.equal(certificates.describeVerification(tampered).valid, false)
  })

  await check('titles are worded from one place', async () => {
    assert.equal(certificates.buildCertificateTitle({ kind: 'funded', accountSize: 100000 }), '$100,000 Funded Trader')
    assert.equal(certificates.buildCertificateTitle({ kind: 'phase_passed', accountType: 'phase1', accountSize: 50000 }), 'Phase 1 Challenge — $50,000')
    assert.equal(certificates.buildCertificateTitle({ kind: 'phase_passed', accountType: 'phase2', accountSize: 200000 }), 'Phase 2 Challenge — $200,000')
    assert.equal(certificates.buildCertificateTitle({ kind: 'payout', amount: 4500 }), '$4,500 Profit Payout')
    assert.equal(certificates.buildCertificateTitle({ kind: 'payout', amount: 4512.75 }), '$4,512.75 Profit Payout')
  })

  // ── Templates ────────────────────────────────────────────────────────────
  const { Resvg } = require('@resvg/resvg-js')
  const artwork = (w, h, fill) => new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`,
    { fitTo: { mode: 'width', value: w } }
  ).render().asPng()

  await check('upload rejects junk, small images and oversized files', async () => {
    assert.throws(() => templates.persistTemplateImage(Buffer.from('definitely not a png')), /PNG or JPEG/)
    assert.throws(() => templates.persistTemplateImage(artwork(400, 300, '#111')), /at least 1600x1100/)
    assert.throws(() => templates.persistTemplateImage(Buffer.alloc(9 * 1024 * 1024, 1)), /8MB or smaller/)
    assert.throws(() => templates.persistTemplateImage(Buffer.alloc(0)), /No template image/)
  })

  let defaultTemplate = null
  await check('default template uploads and activates', async () => {
    const stored = templates.persistTemplateImage(artwork(2000, 1400, '#1B1006'))
    assert.equal(stored.width, 2000)
    assert.equal(stored.height, 1400)
    defaultTemplate = await templates.createTemplate(db, {
      kind: null, name: 'House default', imagePath: stored.imagePath,
      width: stored.width, height: stored.height, uploadedBy: 'admin:test'
    })
    assert.equal(defaultTemplate.is_active, true)
    assert.equal(defaultTemplate.kind, null)
    assert.equal(defaultTemplate.version, 1)
  })

  await check('resolution order prefers a kind-specific template', async () => {
    const viaDefault = await templates.resolveTemplateForKind(db, 'funded')
    assert.equal(viaDefault.id, defaultTemplate.id, 'falls back to the default')

    const stored = templates.persistTemplateImage(artwork(2400, 1600, '#06131B'))
    const funded = await templates.createTemplate(db, {
      kind: 'funded', name: 'Funded special', imagePath: stored.imagePath,
      width: stored.width, height: stored.height, uploadedBy: 'admin:test'
    })
    const viaKind = await templates.resolveTemplateForKind(db, 'funded')
    assert.equal(viaKind.id, funded.id, 'kind-specific wins')
    const stillDefault = await templates.resolveTemplateForKind(db, 'payout')
    assert.equal(stillDefault.id, defaultTemplate.id, 'other kinds still get the default')
  })

  await check('only one template stays active per kind', async () => {
    const active = await db.query(
      `SELECT COALESCE(kind,'__default__') k, COUNT(*)::int c
         FROM certificate_templates WHERE is_active GROUP BY 1 HAVING COUNT(*) > 1`
    )
    assert.equal(active.rows.length, 0, 'partial unique index holds')
  })

  let pinnedCertificate = null
  await check('issuing pins the template version', async () => {
    const issued = await certificates.issueCertificate(db, {
      userId, kind: 'funded', title: '$250,000 Funded Trader',
      recipientName: 'Alexandra Whitmore', amount: 250000,
      sourceKey: 'promotion:pinning-test'
    })
    pinnedCertificate = issued.certificate
    const active = await templates.resolveTemplateForKind(db, 'funded')
    assert.equal(String(pinnedCertificate.template_id), String(active.id))
  })

  await check('editing a template does not change issued certificates', async () => {
    const before = pinnedCertificate.template_id
    const moved = normalizeLayout({ fields: { recipient_name: { x: 0.25, y: 0.3, size: 0.05 } } })
    const newVersion = await templates.saveTemplateLayout(db, before, moved, 'admin:test')

    assert.equal(newVersion.version, 2, 'a save creates the next version')
    assert.notEqual(String(newVersion.id), String(before))

    const reread = await certificates.getById(db, pinnedCertificate.id)
    assert.equal(String(reread.template_id), String(before), 'existing certificate still pinned to v1')

    const next = await certificates.issueCertificate(db, {
      userId, kind: 'funded', title: '$300,000 Funded Trader',
      recipientName: 'Alexandra Whitmore', amount: 300000, sourceKey: 'promotion:after-edit'
    })
    assert.equal(String(next.certificate.template_id), String(newVersion.id), 'new certificate uses v2')
  })

  await check('a template with issued certificates cannot be deleted', async () => {
    await assert.rejects(
      () => templates.deleteTemplate(db, pinnedCertificate.template_id),
      /cannot be deleted/
    )
  })

  await check('renders against an uploaded template', async () => {
    const cert = await certificates.getById(db, pinnedCertificate.id)
    const tpl = await templates.getTemplateById(db, cert.template_id)
    const png = await renderCertificatePng(cert, tpl)
    assert.ok(png.length > 5000, 'produced a real PNG')
    assert.equal(png.subarray(0, 4).toString('hex'), '89504e47')
  })

  await check('revoke flips status and verification', async () => {
    const revoked = await certificates.revokeCertificate(db, pinnedCertificate.id, { reason: 'Rule breach', actor: 'admin:test' })
    assert.equal(revoked.status, 'revoked')
    assert.ok(revoked.revoked_at)
    const verdict = certificates.describeVerification(revoked)
    assert.equal(verdict.valid, false)
    assert.equal(verdict.status, 'revoked')
    assert.equal(verdict.signatureValid, true, 'still authentic, just no longer valid')
  })

  await check('reissue supersedes the original', async () => {
    const issued = await certificates.issueCertificate(db, {
      userId, kind: 'payout', title: '$4,500 Profit Payout',
      recipientName: 'Alexandra Whitmore', amount: 4500, sourceKey: 'payout:reissue-src'
    })
    const fresh = await certificates.reissueCertificate(db, issued.certificate.id, { actor: 'admin:test' })
    assert.notEqual(fresh.public_id, issued.certificate.public_id)
    assert.equal(fresh.metadata.reissued_from, issued.certificate.public_id)
    const original = await certificates.getById(db, issued.certificate.id)
    assert.equal(original.status, 'revoked')
    assert.match(original.revoked_reason, /Superseded by/)
  })

  await check('admin search finds by id, name and email', async () => {
    const byName = await certificates.listCertificates(db, { q: 'Alexandra' })
    assert.ok(byName.total > 0)
    const byEmail = await certificates.listCertificates(db, { q: 'cert-test@example.com' })
    assert.ok(byEmail.total > 0)
    const byId = await certificates.listCertificates(db, { q: pinnedCertificate.public_id })
    assert.equal(byId.total, 1)
    const revokedOnly = await certificates.listCertificates(db, { status: 'revoked' })
    assert.ok(revokedOnly.certificates.every((c) => c.status === 'revoked'))
    const fundedOnly = await certificates.listCertificates(db, { kind: 'funded' })
    assert.ok(fundedOnly.certificates.every((c) => c.kind === 'funded'))
  })

  await db.end()

  console.log('')
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? 'PASS' : 'FAIL'}  ${name}`)
  const failed = results.filter(([s]) => s === 'FAIL').length
  console.log(`\n  ${results.length - failed}/${results.length} passed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
