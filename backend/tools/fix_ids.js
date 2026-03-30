/**
 * WARNING: This is a one-time migration/debug script.
 * DO NOT run this in production unless explicitly instructed.
 * This script may modify database schema or data irreversibly.
 */

const fs = require('fs');

function replaceFile(path, oldText, newText) {
  let content = fs.readFileSync(path, 'utf8');
  let newContent = content.split(oldText).join(newText);
  if (content !== newContent) {
    fs.writeFileSync(path, newContent);
    console.log('Fixed', path);
  } else {
    console.log('No changes needed for', path);
  }
}

replaceFile('./routes/admin.js', '!/^\\d+$/.test(idStr)', 'false');
replaceFile('./routes/payouts.js', '!/^\\d+$/.test(accountIdStr)', 'false');
replaceFile('./routes/trades.js', '!/^\\d+$/.test(accountIdStr)', '!accountIdStr');
replaceFile('./routes/accounts.js', '!/^\\d+$/.test(accountIdStr)', 'false');
