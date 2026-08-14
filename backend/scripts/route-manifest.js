// Throwaway verification helper for the admin.js modularization.
// Prints every route the admin router exposes, in Express match order, with the
// depth of its middleware stack. Diffing before/after the refactor proves that
// no path, method, order, or capability guard changed. Delete once merged.
const target = process.argv[2] || '../routes/admin'
const r = require(target)

const out = []
const visit = (stack) => {
  ;(stack || []).forEach((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).sort().join(',')
      out.push(`${methods} ${layer.route.path} [${layer.route.stack.length}]`)
    } else if (layer.handle && layer.handle.stack) {
      visit(layer.handle.stack)
    }
  })
}
visit(r.stack)

console.log(out.join('\n'))
console.error(`# routes: ${out.length}`)
console.error(`# _internals keys: ${r._internals ? Object.keys(r._internals).length : 'MISSING'}`)
console.error(`# __test__ keys: ${r.__test__ ? Object.keys(r.__test__).length : 'MISSING'}`)
