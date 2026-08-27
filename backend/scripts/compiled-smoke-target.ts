// This file is compiled with the application, then executed from dist. Its
// side-effect imports prove that CommonJS emission can resolve the real runtime
// graph without relying on tsx or source files.
import '../config/role'
import '../db'
import '../routes/trades'
import '../routes/admin'
import '../services/tradeEngine'
import '../services/socketService'
import '../services/schedulerService'
import '../server'

console.log('compiled CommonJS module smoke test passed')

// Several legacy modules intentionally keep long-lived pools and timers at
// module scope. This executable verifies that their compiled CommonJS entrypoints
// load synchronously; lifecycle behavior is covered by the Docker boot/SIGTERM
// gate, so end this isolated loader once all imports have succeeded.
process.exit(0)
