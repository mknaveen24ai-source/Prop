const fs = require('fs');
let code = fs.readFileSync('c:/propfirm/backend/server.js', 'utf8');

const missingParams = `  } catch (error) {
    console.error('Price fallback interval error:', error.message)
  }
}, 2000)

// ── Trading engine intervals ──────────────────────────────────────────────────
setInterval(function() { checkSLTP(io) },             500)
setInterval(function() { checkPendingOrders(io) },    500)
setInterval(function() { checkFloatingDrawdown(io) }, 500)

// ── Challenge engine ──────────────────────────────────────────────────────────
runChallengeEngine(io)
setInterval(() => runChallengeEngine(io), 30000)

// ── Weekend force-close (Friday 21:55 UTC) ────────────────────────────────────
`;

if (code.includes('async function weekendForceClose() {')) {
  // It seems the multi-replace deleted the catch block above weekendForceClose
  // I'll carefully replace the broken part
  code = code.replace(`  } catch (error) {\r
async function weekendForceClose() {`, missingParams + `async function weekendForceClose() {`);
  code = code.replace(`  } catch (error) {\nasync function weekendForceClose() {`, missingParams + `async function weekendForceClose() {`);
  
  // Actually, let me just find the spot: '  } catch (error) {'
  // multi_replace showed:
  // -    console.error('Price fallback interval error:', error.message)
  // -  }
  // -}, 2000)
  
  if (!code.includes("checkFloatingDrawdown(io)")) {
      const parts = code.split('async function weekendForceClose() {');
      // The first part ends with `  } catch (error) {\n` or similar.
      // I'll remove the dangling `catch` from the first part since I re-add it.
      const firstPartCleaned = parts[0].replace(/(\s*\}\s*catch\s*\(error\)\s*\{\s*)$/, '');
      code = firstPartCleaned + '\n' + missingParams + 'async function weekendForceClose() {' + parts[1];
  }
  
  fs.writeFileSync('c:/propfirm/backend/server.js', code);
  console.log('Restored missing code');
}
