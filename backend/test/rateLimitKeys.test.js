const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const express = require('express')
const request = require('supertest')
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')

// express-rate-limit's ipKeyGenerator takes an IP STRING. Passing the request
// object returns the request back, and since MemoryStore keys off a Map every
// request then gets its own bucket under a unique object identity -- the
// limiter silently enforces nothing. The whole codebase had this wrong, which
// left the global apiLimiter and passwordResetLimiter completely inert.
//
// The first test demonstrates the failure mode so the reason for the rule is
// legible; the last one is the actual guard against a regression.

function limitedApp(keyGenerator) {
  const app = express()
  app.use(rateLimit({ windowMs: 60_000, max: 2, keyGenerator, validate: false }))
  app.get('/', (_req, res) => res.json({ ok: true }))
  return app
}

async function statuses(app, count, urlPath = '/') {
  const out = []
  for (let i = 0; i < count; i++) {
    const res = await request(app).get(urlPath)
    out.push(res.status)
  }
  return out
}

test('ipKeyGenerator returns the request object unchanged when misused', () => {
  const req = { ip: '198.51.100.4' }
  assert.equal(ipKeyGenerator(req), req, 'passing req is the bug this suite exists for')
  assert.equal(typeof ipKeyGenerator('198.51.100.4'), 'string')
})

test('a req-keyed limiter never rejects, however many requests arrive', async () => {
  const app = limitedApp((req) => ipKeyGenerator(req))
  const codes = await statuses(app, 5)
  assert.deepEqual(codes, [200, 200, 200, 200, 200])
})

test('an ip-keyed limiter rejects past the max', async () => {
  const app = limitedApp((req) => ipKeyGenerator(req.ip))
  const codes = await statuses(app, 4)
  assert.deepEqual(codes, [200, 200, 429, 429])
})

test('ipKeyGenerator normalises IPv6 to a subnet so a /128 rotation cannot evade it', () => {
  // The reason a bare (req) => req.ip is rejected by the library: an attacker
  // with a /64 can otherwise present a fresh address per request.
  const a = ipKeyGenerator('2001:db8::1')
  const b = ipKeyGenerator('2001:db8::2')
  assert.equal(a, b)
  assert.match(a, /\//)
})

test('the real limiters in utils/security.js enforce their limits', async () => {
  // Exercises the exported middleware rather than a local copy, so a future
  // edit to security.js that reintroduces the bug fails here.
  const { apiLimiter } = require('../utils/security')
  const app = express()
  app.use(apiLimiter)
  app.get('/probe', (_req, res) => res.json({ ok: true }))

  // Must not be '/' — apiLimiter's own skip() exempts the root path.
  const codes = await statuses(app, 105, '/probe')
  assert.equal(codes.filter((c) => c === 200).length, 100, 'apiLimiter allows 100/min')
  assert.equal(codes.filter((c) => c === 429).length, 5, 'and rejects the rest')
})

test('no source file passes the request object to ipKeyGenerator', () => {
  // A cheap structural guard: the runtime symptom is silence, so grep for the
  // shape instead of waiting for a limiter to quietly stop working.
  const roots = ['routes', 'utils', 'services']
  const offenders = []

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
      } else if (entry.name.endsWith('.js')) {
        // Strip comments first — security.js documents the bug in prose, and
        // matching that would make this guard cry wolf forever.
        const src = fs.readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
        if (/ipKeyGenerator\(\s*req\s*\)/.test(src)) offenders.push(full)
      }
    }
  }

  for (const root of roots) {
    const dir = path.join(__dirname, '..', root)
    if (fs.existsSync(dir)) walk(dir)
  }

  assert.deepEqual(offenders, [], `pass req.ip, not req: ${offenders.join(', ')}`)
})
