const expectedNodeVersion = '24.19.0'
const actualNodeVersion = process.versions.node

console.log(`[runtime] node=${actualNodeVersion}`)

if (actualNodeVersion !== expectedNodeVersion) {
  console.error(
    `[runtime] Node ${expectedNodeVersion} is required; refusing Node ${actualNodeVersion}`
  )
  process.exitCode = 1
}
