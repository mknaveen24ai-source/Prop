// Verification helper for router modularization.
//
// Prints every route a router exposes, in Express match order, with the depth
// of its middleware stack. Diffing before/after a refactor proves that no path,
// method, order, or middleware guard changed — a dropped authenticateToken or a
// mislaid rate limiter shows up as a changed [2]/[3] rather than passing
// silently.
//
// Written for the routes/admin.js split (9,898 lines) and originally marked
// throwaway. It earned its keep a second time on the routes/trades.js split, so
// it stays.
//
// Usage:
//   node scripts/route-manifest.js ./routes/trades > before.txt
//   ...refactor...
//   node scripts/route-manifest.js ./routes/trades | diff before.txt -
//
// Accepts either a module that IS a router (routes/admin) or one that exports
// { router, ... } (routes/trades).
require('../loadEnv')
const path = require('path')

// Relative targets resolve against the CWD you invoked from, not against this
// script's directory. `require` would do the latter, which meant the only
// argument that worked was '../routes/admin' typed from the repo root — a trap
// worth removing now that this runs against more than one router.
const target = process.argv[2] || './routes/admin'
const resolved = target.startsWith('.') ? path.resolve(process.cwd(), target) : target
const mod = require(resolved)
const r = mod && mod.stack ? mod : mod.router

if (!r || !r.stack) {
  console.error(`route-manifest: ${target} is neither a router nor exports one as \`router\``)
  process.exit(1)
}

const out = []
const visit = (stack) => {
  ;(stack || []).forEach((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).sort().join(',')
      out.push(`${methods} ${layer.route.path} [${layer.route.stack.length}]`)
    } else if (layer.handle && layer.handle.stack) {
      // Sub-router mounted with router.use(...) — recurse so a split router
      // produces the same flat list as the single-file version it replaced.
      visit(layer.handle.stack)
    }
  })
}
visit(r.stack)

console.log(out.join('\n'))
console.error(`# routes: ${out.length}`)
console.error(`# exports: ${Object.keys(mod).sort().join(', ') || '(router itself)'}`)
