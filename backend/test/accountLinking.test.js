const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')
const request = require('supertest')
require('../loadEnv')
const pool = require('../db')

const { getRequestIp, getIpSubnet } = require('../utils/requestIp')
const { parseDeviceSignature, computeFingerprint } = require('../utils/deviceSignature')
const {
  normalizePayoutDestination,
  normalizeKycDocument,
  buildDeviceSignals,
  buildNetworkSignals,
  SIGNAL_TYPES
} = require('../services/identitySignals')
const linking = require('../services/accountLinkingService')

// Covers account sharing / passing-service detection. The highest-value tests
// here are the entropy ones: a detector that treats a shared corporate NAT or a
// Safari anti-fingerprinting hash as evidence would flag hundreds of innocent
// traders, which is worse than detecting nothing at all.
//
// Follows test/supportDisputesHttp.test.js: mock the shared `pool` singleton,
// then drive the real Express router through supertest.

// ─── IP normalization ────────────────────────────────────────────────────────

test('getRequestIp prefers the left-most x-forwarded-for entry', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' }, ip: '10.0.0.1' }
  assert.equal(getRequestIp(req), '203.0.113.7')
})

test('getRequestIp strips IPv4-mapped IPv6 and ports', () => {
  assert.equal(getRequestIp({ headers: {}, ip: '::ffff:203.0.113.7' }), '203.0.113.7')
  assert.equal(getRequestIp({ headers: { 'x-forwarded-for': '203.0.113.7:51234' } }), '203.0.113.7')
  assert.equal(getRequestIp({ headers: { 'x-forwarded-for': '[2001:db8::1]:443' } }), '2001:db8::1')
})

test('getRequestIp falls back rather than throwing', () => {
  assert.equal(getRequestIp({ headers: {} }), 'unknown')
  assert.equal(getRequestIp(null), 'unknown')
  assert.equal(getRequestIp({ headers: {} }, 'admin_ip'), 'admin_ip')
})

test('getIpSubnet reduces IPv4 to /24 and IPv6 to /48', () => {
  assert.equal(getIpSubnet('203.0.113.7'), '203.0.113.0/24')
  assert.equal(getIpSubnet('203.0.113.250'), '203.0.113.0/24')
  assert.equal(getIpSubnet('2001:db8:abcd:1234::1'), '2001:0db8:abcd::/48')
})

test('getIpSubnet rejects private, loopback and CGNAT ranges', () => {
  // A shared 10.x or 127.0.0.1 is a proxy misconfiguration, not a real link —
  // if it were treated as a signal every user behind a bad proxy would cluster.
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.7', '172.16.4.5', '100.64.9.9', '::1', 'fe80::1']) {
    assert.equal(getIpSubnet(ip), null, `${ip} must not produce a subnet`)
  }
})

test('getIpSubnet returns null for junk instead of throwing', () => {
  for (const value of ['unknown', '', null, undefined, 'not-an-ip', '999.999.999.999']) {
    assert.equal(getIpSubnet(value), null)
  }
})

// ─── Device signature ────────────────────────────────────────────────────────

function encodeSignature(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

const GOOD_COMPONENTS = {
  canvas: 'a1b2c3d4e5f6a7b8',
  webgl: 'ANGLE (NVIDIA GeForce RTX 3060)',
  audio: '9f8e7d6c5b4a3210',
  fonts: 'deadbeefcafebabe',
  platform: 'Win32',
  hardwareConcurrency: '16',
  screen: '2560x1440',
  timezone: 'Europe/London'
}

test('parseDeviceSignature ignores a client-supplied hash and recomputes it', () => {
  const parsed = parseDeviceSignature(encodeSignature({
    v: 1,
    hash: 'attacker-chosen-value',
    components: GOOD_COMPONENTS
  }))

  assert.ok(parsed)
  assert.notEqual(parsed.hash, 'attacker-chosen-value')
  assert.equal(parsed.hash, computeFingerprint(GOOD_COMPONENTS))
})

test('parseDeviceSignature is stable for the same components', () => {
  const a = parseDeviceSignature(encodeSignature({ v: 1, components: GOOD_COMPONENTS }))
  const b = parseDeviceSignature(encodeSignature({ v: 1, components: { ...GOOD_COMPONENTS } }))
  assert.equal(a.hash, b.hash)
})

test('parseDeviceSignature rejects oversized, malformed and low-entropy payloads', () => {
  assert.equal(parseDeviceSignature('x'.repeat(5000)), null, 'oversized header')
  assert.equal(parseDeviceSignature('not-base64-json!!'), null, 'unparseable')
  assert.equal(parseDeviceSignature(encodeSignature({ v: 1 })), null, 'no components')
  assert.equal(parseDeviceSignature(encodeSignature({ v: 1, components: [] })), null, 'array not object')
  // Too few stable components to be distinguishing — a hash built from
  // platform + colorDepth alone would collide across thousands of users.
  assert.equal(
    parseDeviceSignature(encodeSignature({ v: 1, components: { platform: 'Win32', colorDepth: '24' } })),
    null,
    'insufficient entropy'
  )
})

test('parseDeviceSignature drops non-scalar and malformed component keys', () => {
  const parsed = parseDeviceSignature(encodeSignature({
    v: 1,
    components: { ...GOOD_COMPONENTS, evil: { nested: true }, 'bad key!': 'x', arr: [1, 2] }
  }))
  assert.ok(parsed)
  assert.equal(parsed.components.evil, undefined)
  assert.equal(parsed.components['bad key!'], undefined)
  assert.equal(parsed.components.arr, undefined)
})

// ─── Signal normalization ────────────────────────────────────────────────────

test('normalizePayoutDestination collapses casing, spacing and JSON wrapping', () => {
  const plain = normalizePayoutDestination('0xAbC123DeF4567890abcdef')
  const spaced = normalizePayoutDestination('  0xabc123def4567890ABCDEF  ')
  const json = normalizePayoutDestination(JSON.stringify({ wallet_address: '0xABC123DEF4567890abcdef', network: 'ERC20' }))
  const otherNetwork = normalizePayoutDestination(JSON.stringify({ wallet_address: '0xabc123def4567890abcdef', network: 'TRC20' }))

  assert.equal(plain, spaced, 'case and whitespace must not change the key')
  assert.equal(plain, json, 'a JSON-wrapped address must match the bare one')
  assert.equal(json, otherNetwork, 'the same wallet on a different network is still the same wallet')
})

test('normalizePayoutDestination ignores blanks and stubs', () => {
  // A blank must never become a signal — it would link every user who left the
  // field empty into one enormous cluster.
  for (const value of ['', null, undefined, '   ', 'n/a']) {
    assert.equal(normalizePayoutDestination(value), null)
  }
})

test('normalizePayoutDestination hashes rather than storing plaintext', () => {
  const hashed = normalizePayoutDestination('0xAbC123DeF4567890abcdef')
  assert.match(hashed, /^[a-f0-9]{64}$/)
  assert.ok(!hashed.includes('abc123'), 'must not embed the address')
})

test('normalizeKycDocument normalizes punctuation and scopes by country', () => {
  const a = normalizeKycDocument('X1234-5678 9', 'GB')
  const b = normalizeKycDocument('x123456789', 'gb')
  const otherCountry = normalizeKycDocument('X123456789', 'IN')

  assert.equal(a, b)
  assert.notEqual(a, otherCountry, 'identical numbering across countries is coincidence, not a link')
  assert.equal(normalizeKycDocument('12', 'GB'), null, 'too short to be a document number')
  assert.equal(normalizeKycDocument(null, 'GB'), null)
})

test('buildNetworkSignals emits both the IP and its subnet, and nothing for unknown', () => {
  const signals = buildNetworkSignals('203.0.113.7')
  assert.deepEqual(signals.map(s => s.type), [SIGNAL_TYPES.IP, SIGNAL_TYPES.IP_SUBNET])
  assert.equal(signals[1].value, '203.0.113.0/24')

  assert.deepEqual(buildNetworkSignals('unknown'), [])
  assert.deepEqual(buildNetworkSignals(null), [])
  // Private IP still yields the exact-IP signal but no subnet.
  assert.deepEqual(buildNetworkSignals('10.0.0.5').map(s => s.type), [SIGNAL_TYPES.IP])
})

test('buildDeviceSignals emits the composite plus individual components', () => {
  const signature = parseDeviceSignature(encodeSignature({ v: 1, components: GOOD_COMPONENTS }))
  const signals = buildDeviceSignals(signature)

  assert.equal(signals.filter(s => s.type === SIGNAL_TYPES.DEVICE_FP).length, 1)
  const components = signals.filter(s => s.type === SIGNAL_TYPES.DEVICE_COMPONENT)
  assert.ok(components.length >= 3, 'canvas/webgl/audio/fonts should each become a component signal')
  // Prefixed so a partial match tells the admin WHICH component matched.
  assert.ok(components.every(s => /^(canvas|webgl|audio|fonts):[a-f0-9]{64}$/.test(s.value)))

  assert.deepEqual(buildDeviceSignals(null), [])
  assert.deepEqual(buildDeviceSignals({}), [])
})

// ─── Clustering ──────────────────────────────────────────────────────────────

test('buildClusters merges transitively linked users and keeps disjoint rings apart', () => {
  const clusters = linking.buildClusters([
    ['a', 'b'],
    ['b', 'c'],   // transitively pulls c into {a,b}
    ['x', 'y'],
    ['q', 'q']    // self-pair is not a link
  ])

  assert.equal(clusters.length, 2)
  const bySize = clusters.slice().sort((m, n) => n.length - m.length)
  assert.deepEqual(bySize[0], ['a', 'b', 'c'])
  assert.deepEqual(bySize[1], ['x', 'y'])
})

test('buildClusterKey is order-independent and membership-sensitive', () => {
  assert.equal(linking.buildClusterKey(['b', 'a', 'c']), linking.buildClusterKey(['a', 'b', 'c']))
  assert.notEqual(linking.buildClusterKey(['a', 'b']), linking.buildClusterKey(['a', 'b', 'c']))
})

// ─── Entropy weighting (the correctness-critical part) ───────────────────────

test('entropyFactor holds full weight for small groups then decays', () => {
  assert.equal(linking.entropyFactor(2), 1)
  assert.equal(linking.entropyFactor(4), 1)
  assert.equal(linking.entropyFactor(8), 0.5)
  assert.equal(linking.entropyFactor(20), 0.2)
  assert.ok(linking.entropyFactor(25) < linking.entropyFactor(10))
})

test('a fingerprint shared by many users scores below the alert threshold', () => {
  // Safari fingerprint randomisation and Brave farbling make unrelated users
  // produce identical canvas hashes. If a mass-shared value still scored as
  // evidence, this feature would flag the whole user base.
  const sharedByFifty = {
    type: SIGNAL_TYPES.DEVICE_FP,
    weight: 40 * linking.entropyFactor(50)
  }
  const { score } = linking.scoreCluster(50, [sharedByFifty])

  assert.ok(
    score < linking.MIN_PERSISTED_SCORE,
    `mass-shared fingerprint scored ${score}, must stay under ${linking.MIN_PERSISTED_SCORE}`
  )
})

test('the same fingerprint shared by two users is high confidence', () => {
  const pairShared = { type: SIGNAL_TYPES.DEVICE_FP, weight: 40 * linking.entropyFactor(2) }
  const alsoPayout = { type: SIGNAL_TYPES.PAYOUT_DEST, weight: 50 * linking.entropyFactor(2) }
  const { score, confidence } = linking.scoreCluster(2, [pairShared, alsoPayout])

  assert.ok(score >= 80, `expected a high score, got ${score}`)
  assert.equal(confidence, 'high')
})

test('clusterSizeFactor damps oversized clusters', () => {
  assert.equal(linking.clusterSizeFactor(2), 1)
  assert.equal(linking.clusterSizeFactor(15), 1)
  assert.equal(linking.clusterSizeFactor(30), 0.5)
  // Same evidence, bigger cluster → lower score.
  const evidence = [{ type: SIGNAL_TYPES.IP, weight: 15 }, { type: SIGNAL_TYPES.DEVICE_FP, weight: 40 }]
  assert.ok(linking.scoreCluster(40, evidence).score < linking.scoreCluster(3, evidence).score)
})

test('confidenceForScore bands match the persisted thresholds', () => {
  assert.equal(linking.confidenceForScore(95), 'high')
  assert.equal(linking.confidenceForScore(80), 'high')
  assert.equal(linking.confidenceForScore(70), 'medium')
  assert.equal(linking.confidenceForScore(60), 'medium')
  assert.equal(linking.confidenceForScore(45), 'low')
})

// ─── Simultaneous execution ──────────────────────────────────────────────────

function series(count, { start = 1_700_000_000_000, stepMs = 60_000, offsetMs = 0, instrument = 'EURUSD', direction = 'buy' } = {}) {
  return Array.from({ length: count }, (unused, index) => ({
    time: start + index * stepMs + offsetMs,
    instrument,
    direction
  }))
}

test('copied order flow scores near 1.0', () => {
  const master = series(10)
  const copier = series(10, { offsetMs: 900 })   // replicated under a second later
  const { overlap, matched } = linking.overlapCoefficient(master, copier)

  assert.equal(matched, 10)
  assert.equal(overlap, 1)
})

test('the same trades placed well outside the window do not match', () => {
  // The offset must not be a whole multiple of the step: shifting a perfectly
  // periodic series by exactly one step realigns it with itself, which is a
  // property of the fixture rather than of the matcher.
  const a = series(10, { stepMs: 60_000 })
  const b = series(10, { stepMs: 60_000, offsetMs: 30_000 })
  const { overlap, matched } = linking.overlapCoefficient(a, b)
  assert.equal(matched, 0)
  assert.equal(overlap, 0)
})

test('opposite direction and different instruments do not match', () => {
  const buys = series(8)
  assert.equal(linking.overlapCoefficient(buys, series(8, { offsetMs: 500, direction: 'sell' })).matched, 0)
  assert.equal(linking.overlapCoefficient(buys, series(8, { offsetMs: 500, instrument: 'GBPUSD' })).matched, 0)
})

test('one burst cannot be matched repeatedly to inflate the score', () => {
  // Five of A's trades inside one window against a single B trade must count
  // once, not five times — otherwise a rapid-fire scalper looks like a copier.
  const a = series(5, { stepMs: 200 })
  const b = [{ time: a[0].time, instrument: 'EURUSD', direction: 'buy' }]
  const { matched } = linking.overlapCoefficient(a, b)
  assert.equal(matched, 1)
})

test('overlap uses min(), so a copier that also trades manually still scores high', () => {
  const master = series(6)
  const copier = [...series(6, { offsetMs: 800 }), ...series(20, { start: 1_800_000_000_000, instrument: 'XAUUSD' })]
  const { overlap } = linking.overlapCoefficient(master, copier)
  assert.equal(overlap, 1)
})

test('a two-trade coincidence is below the minimum matched floor', () => {
  const { matched } = linking.overlapCoefficient(series(2), series(2, { offsetMs: 500 }))
  assert.ok(matched < linking.MIN_MATCHED_TRADES)
})

test('overlapCoefficient handles empty input', () => {
  assert.deepEqual(linking.overlapCoefficient([], series(5)), { overlap: 0, matched: 0 })
  assert.deepEqual(linking.overlapCoefficient(series(5), []), { overlap: 0, matched: 0 })
})

// ─── Admin HTTP surface ──────────────────────────────────────────────────────

const adminRoutes = require('../routes/admin')

const app = express()
app.use(express.json())
app.use('/api/admin', adminRoutes)

const superAdminToken = `Bearer ${jwt.sign(
  {
    role: 'super_admin', adminId: null, atv: 1,
    email: 'admin@test.local', full_name: 'Platform Admin', src: 'env_fallback'
  },
  process.env.ADMIN_JWT_SECRET,
  { expiresIn: '1h' }
)}`
const financeToken = `Bearer ${jwt.sign(
  {
    role: 'finance_ops', adminId: null, atv: 1,
    email: 'finance@test.local', full_name: 'Finance Admin', src: 'env_fallback'
  },
  process.env.ADMIN_JWT_SECRET,
  { expiresIn: '1h' }
)}`

const CLUSTER_ROW = {
  id: 7,
  cluster_key: 'abc123',
  score: 85,
  confidence: 'high',
  member_user_ids: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
  member_count: 2,
  signal_types: ['device_fp', 'simultaneous_execution'],
  signal_summary: {},
  status: 'open',
  first_detected_at: new Date().toISOString(),
  last_detected_at: new Date().toISOString(),
  resolved_at: null,
  resolved_by: null,
  resolution_note: null
}

function installPoolMock(queryHandlers = []) {
  const calls = []
  const handler = async (sql, values) => {
    calls.push({ sql, values })
    for (const [pattern, fn] of queryHandlers) {
      if (pattern.test(sql)) return fn(sql, values)
    }
    if (/admin_token_version/.test(sql)) return { rows: [{ value: '1' }] }
    if (/FROM platform_admins/.test(sql)) {
      return { rows: [{ id: 1, email: 'admin@test.local', role: 'super_admin', status: 'active', token_version: 1 }] }
    }
    return { rows: [] }
  }

  pool.query = handler
  pool.connect = async () => ({
    query: handler,
    release: () => {}
  })
  return calls
}

test('GET /api/admin/account-links returns the standard list contract', async () => {
  installPoolMock([
    [/FROM account_link_clusters c\s+LEFT JOIN LATERAL/i, () => ({ rows: [CLUSTER_ROW] })],
    [/COUNT\(\*\)::int AS count FROM account_link_clusters/i, () => ({ rows: [{ count: 1 }] })],
    [/COUNT\(\*\) FILTER \(WHERE c\.status = 'open'\)/i, () => ({ rows: [{ total: 1, open: 1, high_confidence: 1, confirmed: 0, false_positive: 0, users_involved: 2 }] })],
    [/GROUP BY c\.confidence, c\.status/i, () => ({ rows: [{ confidence: 'high', status: 'open', count: 1 }] })]
  ])

  const res = await request(app)
    .get('/api/admin/account-links?format=list')
    .set('Authorization', superAdminToken)

  assert.equal(res.status, 200)
  for (const key of ['summary', 'rows', 'pagination', 'facets', 'default_sort', 'saved_view_capabilities']) {
    assert.ok(key in res.body, `list contract must include ${key}`)
  }
  assert.equal(res.body.rows.length, 1)
  assert.ok(Array.isArray(res.body.rows[0].allowed_actions))
  assert.ok(res.body.rows[0].allowed_actions.includes('confirm_sharing'))
})

test('GET /api/admin/account-links without format=list returns the bare array', async () => {
  installPoolMock([
    [/FROM account_link_clusters c\s+LEFT JOIN LATERAL/i, () => ({ rows: [CLUSTER_ROW] })],
    [/COUNT\(\*\)::int AS count FROM account_link_clusters/i, () => ({ rows: [{ count: 1 }] })]
  ])

  const res = await request(app)
    .get('/api/admin/account-links')
    .set('Authorization', superAdminToken)

  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body), 'back-compat callers still expect an array')
})

test('resolve requires a reason', async () => {
  installPoolMock()

  const res = await request(app)
    .post('/api/admin/account-links/7/resolve')
    .set('Authorization', superAdminToken)
    .send({ status: 'false_positive' })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /reason/i)
})

test('resolve rejects an unknown status', async () => {
  installPoolMock()

  const res = await request(app)
    .post('/api/admin/account-links/7/resolve')
    .set('Authorization', superAdminToken)
    .send({ status: 'deleted', reason: 'Investigated and cleared by compliance.' })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /status must be one of/i)
})

test('resolve writes to the immutable audit chain inside the transaction', async () => {
  const calls = installPoolMock([
    [/FROM account_link_clusters WHERE id = \$1 FOR UPDATE/i, () => ({ rows: [CLUSTER_ROW] })],
    [/UPDATE account_link_clusters/i, () => ({ rows: [{ ...CLUSTER_ROW, status: 'confirmed_sharing' }] })]
  ])

  const res = await request(app)
    .post('/api/admin/account-links/7/resolve')
    .set('Authorization', superAdminToken)
    .send({ status: 'confirmed_sharing', reason: 'Both accounts traded from one device with a shared wallet.' })

  assert.equal(res.status, 200)

  const audit = calls.find((call) => /INSERT INTO admin_immutable_audit/i.test(call.sql))
  assert.ok(audit, 'expected an immutable audit insert')

  const auditIndex = calls.indexOf(audit)
  const commitIndex = calls.findIndex((call) => /^COMMIT/i.test(call.sql.trim()))
  assert.ok(auditIndex < commitIndex, 'audit must be written before COMMIT so it is atomic with the change')
})

test('detection never enforces — no account is locked or flagged on resolve', async () => {
  const calls = installPoolMock([
    [/FROM account_link_clusters WHERE id = \$1 FOR UPDATE/i, () => ({ rows: [CLUSTER_ROW] })],
    [/UPDATE account_link_clusters/i, () => ({ rows: [{ ...CLUSTER_ROW, status: 'confirmed_sharing' }] })]
  ])

  await request(app)
    .post('/api/admin/account-links/7/resolve')
    .set('Authorization', superAdminToken)
    .send({ status: 'confirmed_sharing', reason: 'Confirmed passing service across both accounts.' })

  const enforcement = calls.find((call) => /UPDATE accounts SET.*(review_flagged|status\s*=\s*'locked')/is.test(call.sql))
  assert.equal(enforcement, undefined, 'this feature alerts, it must never enforce')
})

test('capability is enforced — finance_ops cannot read the linking queue', async () => {
  installPoolMock([
    [/FROM platform_admins/, () => ({ rows: [{ id: 2, email: 'finance@test.local', role: 'finance_ops', status: 'active', token_version: 1 }] })]
  ])

  const res = await request(app)
    .get('/api/admin/account-links?format=list')
    .set('Authorization', financeToken)

  assert.equal(res.status, 403)
})

test('manual scan is super-admin only', async () => {
  installPoolMock([
    [/FROM platform_admins/, () => ({ rows: [{ id: 2, email: 'finance@test.local', role: 'finance_ops', status: 'active', token_version: 1 }] })]
  ])

  const res = await request(app)
    .post('/api/admin/account-links/scan')
    .set('Authorization', financeToken)

  assert.equal(res.status, 403)
})
