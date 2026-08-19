'use strict'

/**
 * Full HTTP surface inventory.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/audit/route-inventory.js            # human-readable
 *     node scripts/audit/route-inventory.js --json     # machine-readable
 *
 * Reconstructs every mounted endpoint as `METHOD /api/full/path`, by pairing the
 * `app.use('/api/x', router)` mounts declared in server.js with the routes each
 * router actually exposes.
 *
 * ── Why not just boot the app and read app.router.stack ──
 *
 * Requiring server.js starts the price feed, the schedulers, the news service,
 * Redis and the socket layer. An inventory that needs the whole platform running
 * is an inventory nobody runs. Requiring the router modules on their own is what
 * `npm run check` already does, so it is known to work.
 *
 * ── Why the mount prefixes are parsed rather than hardcoded ──
 *
 * Several prefixes are shared: eight separate routers mount on /api/admin. A
 * hardcoded list silently goes stale the first time someone adds a router, and
 * an authorization matrix built on a stale list reports "all endpoints covered"
 * while missing the new one — the exact failure this inventory exists to prevent.
 */

require('../../loadEnv')

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')

/**
 * Parse `app.use('/api/x', ..., routerExpr)` out of server.js.
 *
 * Two forms appear in this codebase:
 *   app.use('/api/trades', tradeRoutes)                 -> local const
 *   app.use('/api/certificates', require('./routes/x'))  -> inline require
 *
 * For the first form the const is resolved back to its `require(...)` by a
 * second pass over the file.
 */
function parseMounts() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')

  // const tradeRoutes = require('./routes/trades')  (optionally .router etc.)
  const constToModule = new Map()
  const constRe = /const\s+\{?\s*([A-Za-z0-9_,:\s]+?)\s*\}?\s*=\s*require\('(\.[^']+)'\)/g
  let m
  while ((m = constRe.exec(src))) {
    const names = m[1].split(',').map((s) => s.trim().split(':').pop().trim())
    for (const name of names) if (name) constToModule.set(name, m[2])
  }

  const mounts = []
  const useRe = /app\.use\(\s*'(\/api\/[^']*)'\s*,\s*([^)]*?)\)\s*(?:\/\/.*)?$/gm
  while ((m = useRe.exec(src))) {
    const prefix = m[1]
    const rest = m[2]

    // Inline require, possibly with a property access.
    const inline = rest.match(/require\('(\.[^']+)'\)(?:\.([A-Za-z0-9_]+))?/)
    if (inline) {
      mounts.push({ prefix, module: inline[1], property: inline[2] || null, raw: rest.trim() })
      continue
    }

    // Last identifier in the argument list is the router; anything before it is
    // middleware (authLimiter, etc.).
    const idents = rest.split(',').map((s) => s.trim()).filter(Boolean)
    const last = idents[idents.length - 1]
    if (!last) continue
    const [base, property] = last.split('.')
    const module = constToModule.get(base)
    if (!module) continue
    mounts.push({ prefix, module, property: property || null, raw: rest.trim() })
  }
  return mounts
}

/**
 * Routes declared straight on the app rather than through a router:
 * `app.get('/api/health', ...)`. Missed on the first pass, which is exactly how
 * an authorization matrix ends up not testing /api/metrics — an endpoint that
 * hands out platform internals. Guard count is approximated by counting the
 * handler arguments, since there is no layer stack to measure.
 */
function parseAppRoutes() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
  const out = []
  const re = /^app\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,([\s\S]*?)$/gm
  let m
  while ((m = re.exec(src))) {
    const argText = m[3]
    const args = argText.split(',').filter((s) => s.trim().length > 0)
    // server.js aliases the admin guard as `authAdm`; /api/metrics further
    // requires requireSuperAdmin. Classified here so these 14 endpoints are not
    // left as 'unknown' in a matrix whose whole job is knowing who may call what.
    const auth = /\bauthAdm\b|\bauthenticateAdmin\b/.test(argText)
      ? 'admin'
      : /\bauthenticateToken\b/.test(argText)
        ? 'trader'
        : 'public'
    out.push({
      method: m[1].toUpperCase(),
      path: m[2],
      guards: Math.max(1, args.length),
      auth,
      superAdminOnly: /\brequireSuperAdmin\b/.test(argText),
      source: './server.js',
      prefix: m[2].startsWith('/api/') ? '/' + m[2].split('/').slice(1, 3).join('/') : '/'
    })
  }
  return out
}

/**
 * Middleware identity for one route layer.
 *
 * `authenticateToken`, `authenticateAdmin` and `enforceAdminCapability` all
 * survive as real function names, which is what makes the expected-authorization
 * ground truth readable off the running router rather than guessed from the URL.
 * `requireAdminCapability('x')` returns a closure, so the capability STRING is
 * not recoverable here — it is recovered separately by parsing the source.
 */
function guardNames(routeStack) {
  return routeStack
    .map((layer) => layer.name || '<anonymous>')
    .filter((name) => name !== '<anonymous>')
}

/** Flatten one Express router into [{ method, path, guards, guardNames }]. */
function enumerateRouter(router) {
  const out = []
  const visit = (stack, prefix) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const routePath = prefix + (layer.route.path === '/' && prefix ? '' : layer.route.path)
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue
          out.push({
            method: method.toUpperCase(),
            path: routePath,
            guards: layer.route.stack.length,
            guardNames: guardNames(layer.route.stack)
          })
        }
      } else if (layer.handle && layer.handle.stack) {
        visit(layer.handle.stack, prefix)
      }
    }
  }
  visit(router.stack, '')
  return out
}

/**
 * Recover the capability string for each admin route by parsing source, since
 * requireAdminCapability('x') is a closure by the time the router is built.
 *
 * Returns Map of 'METHOD routerPath' -> capability. Keyed on the router-relative
 * path, because that is what appears in the source.
 */
function parseCapabilities() {
  const caps = new Map()
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.js')) continue
      const src = fs.readFileSync(full, 'utf8')
      const re = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,([\s\S]{0,400}?)(?:async\s+)?function|router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,([\s\S]{0,400}?)(?:async\s*)?\(/g
      let m
      while ((m = re.exec(src))) {
        const method = (m[1] || m[4] || '').toUpperCase()
        const routePath = m[2] || m[5] || ''
        const args = m[3] || m[6] || ''
        const cap = args.match(/requireAdminCapability\(\s*'([^']+)'/)
        if (cap) caps.set(`${method} ${routePath}`, cap[1])
      }
    }
  }
  walk(path.join(ROOT, 'routes'))
  return caps
}

function loadRouter(mount) {
  const resolved = path.join(ROOT, mount.module)
  const mod = require(resolved)
  const candidate = mount.property ? mod[mount.property] : mod
  if (candidate && candidate.stack) return candidate
  if (mod && mod.router && mod.router.stack) return mod.router
  if (mod && mod.stack) return mod
  return null
}

function buildInventory() {
  const endpoints = []
  const problems = []
  const seen = new Set()
  const capabilities = parseCapabilities()

  for (const mount of parseMounts()) {
    let router
    try {
      router = loadRouter(mount)
    } catch (error) {
      problems.push(`${mount.prefix} -> ${mount.module}: ${error.message}`)
      continue
    }
    if (!router) {
      problems.push(`${mount.prefix} -> ${mount.module}: not a router`)
      continue
    }
    for (const route of enumerateRouter(router)) {
      const full = (mount.prefix + route.path).replace(/\/+$/, '') || mount.prefix
      const key = `${route.method} ${full}`
      // Two routers on the same prefix can legitimately expose the same path
      // shape; Express takes the first. Record once, note the duplicate.
      if (seen.has(key)) {
        problems.push(`duplicate route shadowed: ${key} (second definition in ${mount.module})`)
        continue
      }
      seen.add(key)
      const names = route.guardNames || []
      endpoints.push({
        method: route.method,
        path: full,
        guards: route.guards,
        guardNames: names,
        auth: names.includes('authenticateAdmin')
          ? 'admin'
          : names.includes('authenticateToken')
            ? 'trader'
            : 'public',
        capability: capabilities.get(`${route.method} ${route.path}`) || null,
        source: mount.module,
        prefix: mount.prefix
      })
    }
  }

  for (const route of parseAppRoutes()) {
    const key = `${route.method} ${route.path}`
    if (seen.has(key)) continue
    seen.add(key)
    endpoints.push({ ...route, guardNames: [], auth: route.auth || 'unknown', capability: null })
  }

  endpoints.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method))
  return { endpoints, problems }
}

if (require.main === module) {
  const { endpoints, problems } = buildInventory()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ endpoints, problems }, null, 2))
  } else {
    for (const e of endpoints) {
      const cap = e.capability ? `  cap=${e.capability}` : ''
      console.log(`${e.method.padEnd(6)} ${e.path.padEnd(52)} ${String(e.auth).padEnd(7)}${cap}`)
    }
    console.log('')
    const byAuth = {}
    for (const e of endpoints) byAuth[e.auth] = (byAuth[e.auth] || 0) + 1
    console.log(`${endpoints.length} endpoints across ${new Set(endpoints.map((e) => e.prefix)).size} mounts`)
    console.log(`  by auth: ${Object.entries(byAuth).map(([k, v]) => `${k}=${v}`).join('  ')}`)
    console.log(`  with an explicit capability: ${endpoints.filter((e) => e.capability).length}`)
    if (problems.length) {
      console.log('')
      console.log('Problems:')
      for (const p of problems) console.log(`  ${p}`)
    }
  }
}

module.exports = { buildInventory, parseMounts, enumerateRouter }
