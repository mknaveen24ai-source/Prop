process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-for-cert-http-tests'
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://propfirm.example.com'

const express = require('express')
const cookieParser = require('cookie-parser')
const request = require('supertest')
const jwt = require('jsonwebtoken')
const assert = require('node:assert/strict')
const { Client } = require('pg')

const certificatesRouter = require('../../routes/certificates')
const certificates = require('../../services/certificateService')

const results = []
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]) }
  catch (error) { results.push(['FAIL', `${name} :: ${error.message}`]) }
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()

  const user = await db.query(
    `INSERT INTO users (email, password_hash, full_name, country, token_version)
     VALUES ('http-cert@example.com', 'x', 'Wei Zhang', 'SG', 0)
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`
  )
  const userId = user.rows[0].id

  const other = await db.query(
    `INSERT INTO users (email, password_hash, full_name, country, token_version)
     VALUES ('http-other@example.com', 'x', 'Someone Else', 'SG', 0)
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`
  )
  const otherUserId = other.rows[0].id

  const { certificate } = await certificates.issueCertificate(db, {
    userId, kind: 'funded', title: '$100,000 Funded Trader',
    recipientName: 'Wei Zhang', amount: 100000, sourceKey: `promotion:http-${Date.now()}`
  })

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/certificates', certificatesRouter)

  const token = (id) => jwt.sign({ userId: id, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' })
  const asUser = (id) => ({ Cookie: `token=${token(id)}` })

  await check('public verification returns the certificate unauthenticated', async () => {
    const res = await request(app).get(`/api/certificates/public/${certificate.public_id}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.valid, true)
    assert.equal(res.body.status, 'active')
    assert.equal(res.body.signatureValid, true)
    assert.equal(res.body.certificate.recipient_name, 'Wei Zhang')
    assert.equal(res.body.certificate.title, '$100,000 Funded Trader')
    assert.ok(res.body.certificate.verify_url.endsWith(`/verify/${certificate.public_id}`))
    assert.equal(res.body.certificate.user_id, undefined, 'must not leak the internal user id')
  })

  await check('unknown certificate verifies as not_found (404)', async () => {
    const res = await request(app).get('/api/certificates/public/PF-2026-DEAD-BEEF')
    assert.equal(res.status, 404)
    assert.equal(res.body.valid, false)
    assert.equal(res.body.status, 'not_found')
  })

  await check('public render.png returns a real PNG', async () => {
    const res = await request(app).get(`/api/certificates/public/${certificate.public_id}/render.png?w=800`)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /image\/png/)
    assert.equal(res.body.subarray(0, 4).toString('hex'), '89504e47')
  })

  await check('public render.svg returns SVG', async () => {
    const res = await request(app).get(`/api/certificates/public/${certificate.public_id}/render.svg`)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /image\/svg\+xml/)
    // supertest buffers image/* responses, so read the body rather than .text
    const svg = res.text || res.body.toString('utf8')
    assert.match(svg, /^<svg /)
    assert.ok(svg.includes('crispEdges'), 'QR block is inlined')
  })

  await check('trader list requires auth', async () => {
    assert.equal((await request(app).get('/api/certificates')).status, 401)
  })

  await check('trader lists their own certificates', async () => {
    const res = await request(app).get('/api/certificates').set(asUser(userId))
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body))
    assert.ok(res.body.some((c) => c.public_id === certificate.public_id))
  })

  await check("another trader cannot read someone else's certificate", async () => {
    const res = await request(app).get(`/api/certificates/${certificate.public_id}`).set(asUser(otherUserId))
    assert.equal(res.status, 404, 'must 404, not 200 and not 403')
  })

  await check("another trader cannot render someone else's certificate", async () => {
    const res = await request(app).get(`/api/certificates/${certificate.public_id}/render.png`).set(asUser(otherUserId))
    assert.equal(res.status, 404)
  })

  await check('owner downloads a PDF with an attachment header', async () => {
    const res = await request(app).get(`/api/certificates/${certificate.public_id}/render.pdf`).set(asUser(userId))
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /application\/pdf/)
    assert.match(res.headers['content-disposition'], /attachment; filename="certificate-PF-/)
    assert.equal(res.body.subarray(0, 4).toString('ascii'), '%PDF')
  })

  await check('PNG is inline by default and an attachment on ?download=1', async () => {
    const inline = await request(app).get(`/api/certificates/${certificate.public_id}/render.png`).set(asUser(userId))
    assert.equal(inline.status, 200)
    assert.equal(inline.headers['content-disposition'], undefined)

    const download = await request(app).get(`/api/certificates/${certificate.public_id}/render.png?download=1`).set(asUser(userId))
    assert.match(download.headers['content-disposition'], /attachment/)
  })

  await check('"public" is not swallowed by the :publicId route', async () => {
    // Registration order matters: /public/... must be matched before /:publicId.
    const res = await request(app).get(`/api/certificates/public/${certificate.public_id}`)
    assert.equal(res.status, 200, 'public route still reachable with no auth')
  })

  await check('revoked certificate reports revoked, not valid', async () => {
    const row = await certificates.getByPublicId(db, certificate.public_id)
    await certificates.revokeCertificate(db, row.id, { reason: 'Rule breach', actor: 'admin:test' })
    const res = await request(app).get(`/api/certificates/public/${certificate.public_id}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.valid, false)
    assert.equal(res.body.status, 'revoked')
    assert.equal(res.body.signatureValid, true)
    assert.equal(res.body.certificate.revoked_reason, 'Rule breach')
  })

  await check('a tampered row is reported as tampered by the public page', async () => {
    await db.query(`UPDATE certificates SET title = '$900,000 Funded Trader' WHERE public_id = $1`, [certificate.public_id])
    const res = await request(app).get(`/api/certificates/public/${certificate.public_id}`)
    assert.equal(res.body.signatureValid, false)
    assert.equal(res.body.valid, false)
  })

  await db.end()

  console.log('')
  for (const [state, name] of results) console.log(`  ${state}  ${name}`)
  const failed = results.filter(([s]) => s === 'FAIL').length
  console.log(`\n  ${results.length - failed}/${results.length} passed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
