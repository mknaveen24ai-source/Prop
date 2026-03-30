/**
 * WARNING: This is a one-time migration/debug script.
 * DO NOT run this in production unless explicitly instructed.
 * This script may modify database schema or data irreversibly.
 */

const fs = require('fs');
let code = fs.readFileSync('c:/propfirm/backend/server.js', 'utf8');

// Replace integer variable with string explicitly in all recent added queries.
code = code.replace(/user_id = \$1 ORDER BY created_at DESC', \[req\.user\.userId\]/g, "user_id = $1 ORDER BY created_at DESC', [String(req.user.userId)]");
code = code.replace(/AND user_id = \$2', \[req\.params\.id, req\.user\.userId\]/g, "AND user_id = $2', [req.params.id, String(req.user.userId)]");
code = code.replace(/user_id = \$2', \[req\.params\.id, req\.user\.userId\]/g, "user_id = $2', [req.params.id, String(req.user.userId)]");

fs.writeFileSync('c:/propfirm/backend/server.js', code);
console.log('Fixed DB type errors for tickets');
