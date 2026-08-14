// Guards the admin/ module split: every name a sub-router destructures out of a
// require must actually be exported by the target module.
//
// Node resolves a missing export to `undefined` at load time without error, so a
// dropped binding stays silent until the route runs. Neither the route manifest
// nor a syntax check catches it. This does.
const fs = require('fs')
const path = require('path')

const DIRS = [
  path.join(__dirname, '../routes/admin'),
  path.join(__dirname, '../routes/admin/shared')
]

const failures = []

for (const dir of DIRS) {
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const filePath = path.join(dir, file)
    const source = fs.readFileSync(filePath, 'utf8')

    // const { a, b, c } = require('...')
    const re = /const \{([^}]+)\} = require\('([^']+)'\)/g
    let m
    while ((m = re.exec(source)) !== null) {
      const names = m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean)
      const target = m[2]

      let mod
      try {
        mod = require(target.startsWith('.') ? path.resolve(dir, target) : target)
      } catch (err) {
        failures.push(`${file}: cannot load '${target}' — ${err.message}`)
        continue
      }

      for (const name of names) {
        if (mod[name] === undefined) {
          failures.push(`${file}: '${name}' is not exported by '${target}'`)
        }
      }
    }
  }
}

if (failures.length) {
  console.error('Broken admin module bindings:\n' + failures.map((f) => '  ' + f).join('\n'))
  process.exit(1)
}
console.log('admin module bindings OK')
