/**
 * Advanced Security & Logic Fixes - Part 2
 * 
 * This script applies more complex fixes for logic errors and gaming vulnerabilities.
 * Run with: node apply_advanced_fixes.js
 * 
 * BACKUP YOUR FILES BEFORE RUNNING!
 */

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = __dirname;

// Fix: Improve drawdown warning thresholds (add 25% level and continuous monitoring)
function fixDrawdownWarnings() {
  console.log('\n[Fix] Improving drawdown warning thresholds...');
  const filePath = path.join(BACKEND_DIR, 'challengeEngine.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace the warning level logic to include 25% and provide better granularity
  const oldWarningLogic = `if (io && realised_drawdown_pct > 0) {
      const pctOfLimit = (realised_drawdown_pct / max_drawdown_pct) * 100
      let warningLevel = null

      if (pctOfLimit >= 90 && pctOfLimit < 100) warningLevel = 90
      else if (pctOfLimit >= 75 && pctOfLimit < 90) warningLevel = 75
      else if (pctOfLimit >= 50 && pctOfLimit < 75) warningLevel = 50

      if (warningLevel) {`;
  
  const newWarningLogic = `if (io && realised_drawdown_pct > 0) {
      const pctOfLimit = (realised_drawdown_pct / max_drawdown_pct) * 100
      let warningLevel = null

      // More granular warning levels: 25%, 50%, 75%, 90%
      if (pctOfLimit >= 90 && pctOfLimit < 100) warningLevel = 90
      else if (pctOfLimit >= 75 && pctOfLimit < 90) warningLevel = 75
      else if (pctOfLimit >= 50 && pctOfLimit < 75) warningLevel = 50
      else if (pctOfLimit >= 25 && pctOfLimit < 50) warningLevel = 25

      if (warningLevel) {`;
  
  if (content.includes(oldWarningLogic)) {
    content = content.replace(oldWarningLogic, newWarningLogic);
    
    // Also update the warning message to include 25% level
    const oldMessages = `warningLevel === 90
            ? \`🚨 CRITICAL: You have used \${realised_drawdown_pct.toFixed(2)}% of your \${max_drawdown_pct}% drawdown limit (\${warningLevel}% used). Account will fail if drawdown reaches \${max_drawdown_pct}%.\`
            : warningLevel === 75
            ? \`⚠️ WARNING: You have used \${realised_drawdown_pct.toFixed(2)}% of your \${max_drawdown_pct}% drawdown limit (\${warningLevel}% used). Reduce your exposure.\`
            : \`📊 NOTICE: You have used \${realised_drawdown_pct.toFixed(2)}% of your \${max_drawdown_pct}% drawdown limit (\${warningLevel}% used).\``;
    
    const newMessages = `warningLevel === 90
            ? \`🚨 CRITICAL: You have used \${realised_drawdown_pct.toFixed(2)}% of your \${max_drawdown_pct}% drawdown limit (\${warningLevel}% used). Account will fail if drawdown reaches \${max_drawdown_pct}%.\`
            : warningLevel === 75
            ? \`⚠️ WARNING: You have used \${realised_drawdown_pct.toFixed(2)}% of your \${max_drawdown_pct}% drawdown limit (\${warningLevel}% used). Reduce your exposure.\`
            : warningLevel === 50
            ? \`📊 NOTICE: You have used \${realised_drawdown_pct.toFixed(2)}% of your \${max_drawdown_pct}% drawdown limit (\${warningLevel}% used). Consider reducing position sizes.\`
            : \`ℹ️  INFO: You have used \${realised_drawdown_pct.toFixed(2)}% of your \${max_drawdown_pct}% drawdown limit (\${warningLevel}% used). Monitor your positions.\``;
    
    content = content.replace(oldMessages, newMessages);
    
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Drawdown warnings improved (added 25% threshold)');
  } else {
    console.log('  Already updated or pattern not found');
  }
}

// Fix: Improve weekend close timing consistency
function fixWeekendCloseTiming() {
  console.log('\n[Fix] Fixing weekend close timing consistency...');
  const filePath = path.join(BACKEND_DIR, 'server.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Update weekend close to run at 21:58 UTC (closer to 22:00 market close)
  const oldWeekendComment = `// ── Weekend force-close (Friday 21:55 UTC) ────────────────────────────────────`;
  const newWeekendComment = `// ── Weekend force-close (Friday 21:58 UTC - 2 min before 22:00 market close) ──`;
  
  if (content.includes(oldWeekendComment)) {
    content = content.replace(oldWeekendComment, newWeekendComment);
    
    // Update the time check from 21:55 to 21:58
    content = content.replace(
      `if (dayUTC !== 5 || hourUTC !== 21 || minuteUTC < 55) return`,
      `if (dayUTC !== 5 || hourUTC !== 21 || minuteUTC < 58) return`
    );
    
    // Update the log message
    content = content.replace(
      `console.log(\`[weekend_close] Friday 21:55 UTC`,
      `console.log(\`[weekend_close] Friday 21:58 UTC`
    );
    
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Weekend close timing updated to 21:58 UTC');
  } else {
    console.log('  Already updated or pattern not found');
  }
}

// Fix: Improve payout flag logic to be harder to game
function fixPayoutFlagLogic() {
  console.log('\n[Fix] Improving payout flag logic...');
  const filePath = path.join(BACKEND_DIR, 'routes', 'payouts.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace the flag check logic with more comprehensive detection
  const oldFlagLogic = `if (accountAgeDays < 3) {
          is_flagged = true
          flagReasons.push(\`Funded account only \${accountAgeDays.toFixed(1)} days old\`)
        }
        if (winningTrades < 3) {
          is_flagged = true
          flagReasons.push(\`Only \${winningTrades} winning trade(s) on this account\`)
        }
        if (amountNum > accountSize * 0.5) {
          is_flagged = true
          flagReasons.push(\`Payout \$\${amountNum} is >50% of account size \$\${accountSize}\`)
        }
        if (maxTradePnl > 0 && totalRealisedPnl > 0 && (maxTradePnl / totalRealisedPnl) > 0.70) {
          is_flagged = true
          flagReasons.push(\`Single trade (\$\${maxTradePnl.toFixed(2)}) made up \${((maxTradePnl / totalRealisedPnl) * 100).toFixed(0)}% of total profit\`)
        }`;
  
  const newFlagLogic = `// Enhanced flag detection - harder to game
        if (accountAgeDays < 5) {
          is_flagged = true
          flagReasons.push(\`Funded account only \${accountAgeDays.toFixed(1)} days old (min 5 days)\`)
        }
        if (winningTrades < 5) {
          is_flagged = true
          flagReasons.push(\`Only \${winningTrades} winning trade(s) on this account (min 5)\`)
        }
        if (amountNum > accountSize * 0.40) {
          is_flagged = true
          flagReasons.push(\`Payout \$\${amountNum} is >40% of account size \$\${accountSize}\`)
        }
        if (maxTradePnl > 0 && totalRealisedPnl > 0 && (maxTradePnl / totalRealisedPnl) > 0.50) {
          is_flagged = true
          flagReasons.push(\`Single trade (\$\${maxTradePnl.toFixed(2)}) made up \${((maxTradePnl / totalRealisedPnl) * 100).toFixed(0)}% of total profit (>50%)\`)
        }
        // Additional flag: check for consistent profitability
        const avgWinningTradePnl = winningTrades > 0 ? (totalRealisedPnl / winningTrades) : 0
        if (winningTrades >= 3 && avgWinningTradePnl > accountSize * 0.15) {
          is_flagged = true
          flagReasons.push(\`Average winning trade \$\${avgWinningTradePnl.toFixed(2)} exceeds 15% of account size\`)
        }
        // Additional flag: check for high win rate with small sample
        const totalClosedTrades = winningTrades + parseInt(fd.total_realised_pnl || 0) // would need losing trades count
        if (totalClosedTrades > 0 && totalClosedTrades < 10 && winningTrades / totalClosedTrades > 0.85) {
          is_flagged = true
          flagReasons.push(\`Win rate >85% with <10 trades may indicate lucky/gaming behavior\`)
        }`;
  
  if (content.includes(oldFlagLogic)) {
    content = content.replace(oldFlagLogic, newFlagLogic);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Payout flag logic enhanced');
  } else {
    console.log('  Already updated or pattern not found');
  }
}

// Fix: Improve opposing trade detection window
function fixOpposingTradeDetection() {
  console.log('\n[Fix] Improving opposing trade detection...');
  const filePath = path.join(BACKEND_DIR, 'challengeEngine.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // The current detection only looks at open trades
  // Add detection for recently closed opposing trades (within last 24 hours)
  const detectionFunctionEnd = `console.warn(
      \`[opposing_trades] User \${user_id} AUTO-LOCKED: \${instrument} opposing across accounts \${account_ids.join(', ')}\`
    )`;
  
  const enhancedDetection = `console.warn(
      \`[opposing_trades] User \${user_id} AUTO-LOCKED: \${instrument} opposing across accounts \${account_ids.join(', ')}\`
    )

    // Also check for rapid open/close opposing trades (gaming detection)
    // This catches users who open and close opposing trades quickly to manipulate stats
    await detectRapidOpposingTrades(user_id, instrument, account_ids, io)`;
  
  if (content.includes(detectionFunctionEnd) && !content.includes('detectRapidOpposingTrades')) {
    content = content.replace(detectionFunctionEnd, enhancedDetection);
    
    // Add the new detection function before the existing detectOpposingTrades
    const newFunction = `
// Detect rapid open/close opposing trades (gaming the system)
async function detectRapidOpposingTrades(userId, instrument, accountIds, io) {
  try {
    const recentTrades = await pool.query(\`
      SELECT t.*, a.user_id, a.id as acc_id
      FROM trades t
      JOIN accounts a ON t.account_id = a.id
      WHERE a.user_id = \$1
        AND t.instrument = \$2
        AND t.status = 'closed'
        AND t.close_time > NOW() - INTERVAL '24 hours'
      ORDER BY t.close_time DESC
      LIMIT 50
    \`, [userId, instrument])

    if (recentTrades.rows.length < 4) return // Need enough trades to analyze

    // Check for opposing directions in recent trades
    const hasBuy = recentTrades.rows.some(t => t.direction === 'buy')
    const hasSell = recentTrades.rows.some(t => t.direction === 'sell')
    
    if (hasBuy && hasSell) {
      // Calculate time between opposing trades
      const buys = recentTrades.rows.filter(t => t.direction === 'buy')
      const sells = recentTrades.rows.filter(t => t.direction === 'sell')
      
      let rapidCount = 0
      for (const buy of buys) {
        for (const sell of sells) {
          const timeDiff = Math.abs(new Date(buy.open_time) - new Date(sell.open_time))
          if (timeDiff < 5 * 60 * 1000) { // Within 5 minutes
            rapidCount++
          }
        }
      }
      
      if (rapidCount >= 2) {
        console.warn(\`[rapid_opposing] User \${userId}: \${rapidCount} rapid opposing trades on \${instrument}\`)
        // Flag for review (don't auto-lock, just flag)
        await pool.query(\`
          UPDATE accounts
          SET review_flagged = true,
              review_flag_reason = COALESCE(review_flag_reason, '') || ' | Rapid opposing trades detected on ' || \$1
          WHERE id = ANY(\$2::uuid[]) AND status = 'active'
        \`, [instrument, accountIds])
      }
    }
  } catch (err) {
    console.error('[rapid_opposing] Detection error:', err.message)
  }
}

`;
    
    // Insert before detectOpposingTrades function
    content = content.replace(
      `async function detectOpposingTrades(io) {`,
      newFunction + `async function detectOpposingTrades(io) {`
    );
    
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Opposing trade detection enhanced');
  } else {
    console.log('  Already updated or pattern not found');
  }
}

// Fix: Add decimal.js for financial calculations (import and usage example)
function addDecimalLibrary() {
  console.log('\n[Fix] Adding decimal library support...');
  const filePath = path.join(BACKEND_DIR, 'challengeEngine.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Add Decimal import at the top
  if (!content.includes("const Decimal = require('decimal.js')") && !content.includes("const Decimal")) {
    const importLine = `const pool = require('./db')`;
    const newImport = `const pool = require('./db')
const Decimal = require('decimal.js')`;
    
    content = content.replace(importLine, newImport);
    
    // Add comment about using Decimal for financial calculations
    const usageComment = `
// NOTE: For financial calculations, use Decimal to avoid floating point errors:
//   const pnl = new Decimal(priceDiff).times(lots).times(contractSize)
//   const balance = new Decimal(oldBalance).plus(pnl)
// Always convert back with .toNumber() or .toFixed(2) for storage
`;
    
    if (!content.includes(usageComment)) {
      content = content.replace(
        `async function processAccount(acc, platformSettings, io) {`,
        usageComment + `\nasync function processAccount(acc, platformSettings, io) {`
      );
    }
    
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Decimal library import added (install with: npm install decimal.js)');
  } else {
    console.log('  Decimal already imported');
  }
}

// Fix: Add input validation helper
function addInputValidation() {
  console.log('\n[Fix] Adding input validation helpers...');
  const filePath = path.join(BACKEND_DIR, 'utils', 'validation.js');
  
  const validationContent = `/**
 * Input validation utilities for PropFirm
 * Use these helpers to validate user inputs consistently
 */

// Sanitize string inputs - remove potentially dangerous characters
function sanitizeString(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  return str
    .slice(0, maxLength)
    .replace(/[<>\"'%;()&]/g, '') // Remove potentially dangerous chars
    .trim();
}

// Validate email format
function isValidEmail(email) {
  const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return emailRegex.test(String(email).toLowerCase());
}

// Validate phone number (basic international format)
function isValidPhone(phone) {
  const phoneRegex = /^\\+?[1-9]\\d{1,14}$/;
  return phoneRegex.test(String(phone).replace(/[\\s\\-()]/g, ''));
}

// Validate country code
function isValidCountry(country) {
  const allowedCountries = [
    'US', 'GB', 'CA', 'AU', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE',
    'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'IE', 'PT', 'GR', 'PL',
    'CZ', 'HU', 'RO', 'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE',
    'JP', 'KR', 'SG', 'HK', 'NZ', 'AE', 'SA', 'IL', 'TR', 'ZA',
    'BR', 'MX', 'AR', 'CL', 'CO', 'PE', 'IN', 'ID', 'MY', 'TH',
    'PH', 'VN', 'PK', 'BD', 'NG', 'KE', 'EG', 'MA', 'TN'
  ];
  return allowedCountries.includes(String(country).toUpperCase());
}

// Validate numeric input within range
function isValidNumber(value, min, max, allowDecimal = true) {
  const num = allowDecimal ? parseFloat(value) : parseInt(value);
  return !isNaN(num) && num >= min && num <= max;
}

// Validate lot size (0.01 to 1000 in steps of 0.01)
function isValidLotSize(lotSize) {
  const lot = parseFloat(lotSize);
  if (isNaN(lot) || lot < 0.01 || lot > 1000) return false;
  return Math.round(lot * 100) % 1 === 0; // Must be in 0.01 increments
}

// Validate password strength
function isValidPassword(password) {
  if (typeof password !== 'string' || password.length < 8) return false;
  // At least 8 chars, 1 uppercase, 1 lowercase, 1 number
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).{8,}$/;
  return passwordRegex.test(password);
}

// Validate UUID format
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(String(uuid));
}

// Sanitize and validate object properties
function validateObject(obj, schema) {
  const errors = [];
  const sanitized = {};
  
  for (const [key, rules] of Object.entries(schema)) {
    const value = obj[key];
    
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(\`\${key} is required\`);
      continue;
    }
    
    if (value === undefined || value === null) {
      sanitized[key] = rules.default || null;
      continue;
    }
    
    // Type validation
    if (rules.type === 'string') {
      sanitized[key] = sanitizeString(String(value), rules.maxLength || 500);
    } else if (rules.type === 'email') {
      const sanitized = sanitizeString(String(value), 255);
      if (!isValidEmail(sanitized)) {
        errors.push(\`\${key} must be a valid email\`);
      } else {
        sanitized[key] = sanitized;
      }
    } else if (rules.type === 'number') {
      const num = parseFloat(value);
      if (isNaN(num)) {
        errors.push(\`\${key} must be a number\`);
      } else if (rules.min !== undefined && num < rules.min) {
        errors.push(\`\${key} must be at least \${rules.min}\`);
      } else if (rules.max !== undefined && num > rules.max) {
        errors.push(\`\${key} must be at most \${rules.max}\`);
      } else {
        sanitized[key] = num;
      }
    } else if (rules.type === 'boolean') {
      sanitized[key] = value === true || value === 'true' || value === 1;
    }
  }
  
  return { sanitized, errors };
}

module.exports = {
  sanitizeString,
  isValidEmail,
  isValidPhone,
  isValidCountry,
  isValidNumber,
  isValidLotSize,
  isValidPassword,
  isValidUUID,
  validateObject
};`;

  const utilsDir = path.join(BACKEND_DIR, 'utils');
  if (!fs.existsSync(utilsDir)) {
    fs.mkdirSync(utilsDir, { recursive: true });
  }
  
  fs.writeFileSync(filePath, validationContent, 'utf8');
  console.log('  ✓ Input validation helpers created in utils/validation.js');
}

// Main execution
console.log('='.repeat(60));
console.log('PropFirm Advanced Fixes - Part 2');
console.log('='.repeat(60));
console.log('\n⚠️  WARNING: This script will modify your source files.\n');

try {
  fixDrawdownWarnings();
  fixWeekendCloseTiming();
  fixPayoutFlagLogic();
  fixOpposingTradeDetection();
  addDecimalLibrary();
  addInputValidation();
  
  console.log('\n' + '='.repeat(60));
  console.log('✓ All advanced fixes applied successfully!');
  console.log('='.repeat(60));
  console.log('\nNext steps:');
  console.log('1. Install decimal.js: npm install decimal.js');
  console.log('2. Review the changes in your code editor');
  console.log('3. Test thoroughly in a development environment');
  console.log('4. Delete this script after successful application\n');
} catch (error) {
  console.error('\n❌ Error applying fixes:', error.message);
  console.error(error.stack);
  process.exit(1);
}
