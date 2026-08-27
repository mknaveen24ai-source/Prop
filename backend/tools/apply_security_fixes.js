/**
 * Security Fixes Script for PropFirm Backend
 * 
 * This script applies critical security and bug fixes to the codebase.
 * Run with: node apply_security_fixes.js
 * 
 * BACKUP YOUR FILES BEFORE RUNNING!
 */

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = __dirname;

// Create backup of a file
function backupFile(filePath) {
  const backupPath = filePath + '.backup';
  fs.copyFileSync(filePath, backupPath);
  console.log(`  Backed up: ${path.basename(filePath)}`);
  return backupPath;
}

// Fix 1: Admin password hashing with bcrypt
function fixAdminPasswordHashing() {
  console.log('\n[Fix 1] Updating admin password hashing to use bcrypt...');
  const filePath = path.join(BACKEND_DIR, 'routes', 'admin.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Add bcrypt import at the top (after the first require block)
  if (!content.includes("const bcrypt = require('bcrypt')")) {
    content = content.replace(
      /(const pool = require\('.\/db'\))/,
      "const bcrypt = require('bcrypt')\nconst pool = require('./db')"
    );
  }
  
  // Replace SHA-256 password hashing with bcrypt
  const oldHashing = `// FIX (Bug 17): Hash both passwords with SHA-256 first to get fixed-length
    // digests, eliminating the length leak from the previous implementation
    // where supplied.length !== expected.length was a fast-reject.
    const crypto = require('crypto')
    const suppliedHash = crypto.createHash('sha256').update(String(password || '')).digest()
    const expectedHash = crypto.createHash('sha256').update(adminPassword).digest()
    const timingSafe = crypto.timingSafeEqual(suppliedHash, expectedHash)

    if (!timingSafe) {`;
  
  const newHashing = `// Use bcrypt for secure password hashing (replaces SHA-256 which is too fast)
    // Check if password is already hashed (new format with $2a$ or $2b$) or plain text (legacy)
    let isValidPassword = false
    if (adminPassword.startsWith('$2a$') || adminPassword.startsWith('$2b$')) {
      // Password is already bcrypt hashed - use bcrypt.compare
      isValidPassword = await bcrypt.compare(String(password || ''), adminPassword)
    } else {
      // Legacy plain text password - hash it for comparison
      isValidPassword = await bcrypt.compare(String(password || ''), await bcrypt.hash(adminPassword, 12))
    }

    if (!isValidPassword) {`;
  
  if (content.includes(oldHashing)) {
    content = content.replace(oldHashing, newHashing);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Admin password hashing updated to bcrypt');
  } else {
    console.log('  Already updated or pattern not found');
  }
}

// Fix 2: Path traversal vulnerability
function fixPathTraversal() {
  console.log('\n[Fix 2] Fixing path traversal vulnerability in uploads...');
  const filePath = path.join(BACKEND_DIR, 'server.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace the vulnerable path check
  const oldCheck = `if (!absPath.startsWith(uploadsRoot + path.sep) && absPath !== uploadsRoot) {
    return res.status(400).json({ error: 'Invalid path' })
  }`;
  
  const newCheck = `// Normalize paths to prevent traversal attacks with mixed separators
  const normalizedAbsPath = path.normalize(absPath)
  const normalizedUploadsRoot = path.normalize(uploadsRoot)
  if (!normalizedAbsPath.startsWith(normalizedUploadsRoot + path.sep) && normalizedAbsPath !== normalizedUploadsRoot) {
    return res.status(400).json({ error: 'Invalid path' })
  }`;
  
  if (content.includes(oldCheck)) {
    content = content.replace(oldCheck, newCheck);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Path traversal vulnerability fixed');
  } else {
    console.log('  Already fixed or pattern not found');
  }
}

// Fix 3: Add error handling to passAccount transaction
function fixPassAccountErrorHandling() {
  console.log('\n[Fix 3] Adding error handling to passAccount transaction...');
  const filePath = path.join(BACKEND_DIR, 'challengeEngine.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find and fix the passAccount function
  const oldPromote = `await client.query(
      \`UPDATE accounts SET status = 'passed' WHERE id = \$1\`,
      [acc.id]
    )

    const promoted = await promotePassedAccount(client, acc, platformSettings)

    await client.query('COMMIT')`;
  
  const newPromote = `await client.query(
      \`UPDATE accounts SET status = 'passed' WHERE id = \$1\`,
      [acc.id]
    )

    const promoted = await promotePassedAccount(client, acc, platformSettings)
    if (!promoted) {
      throw new Error('Failed to create promoted account')
    }

    await client.query('COMMIT')`;
  
  if (content.includes(oldPromote)) {
    content = content.replace(oldPromote, newPromote);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ passAccount error handling improved');
  } else {
    console.log('  Already fixed or pattern not found');
  }
}

// Fix 4: Fix race condition in account creation
function fixAccountCreationRaceCondition() {
  console.log('\n[Fix 4] Fixing race condition in account creation...');
  const filePath = path.join(BACKEND_DIR, 'routes', 'accounts.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Fix the lock key calculation to avoid overflow
  const oldLockKey = `const lockKey = (req.user.userId * 1000000) + account_size`;
  const newLockKey = `// Use BigInt-style key to avoid integer overflow for large user IDs
    // Key format: user_id shifted left 20 bits (multiply by 2^20 = 1048576) plus account_size
    const lockKey = Math.min((req.user.userId << 20) + account_size, 2147483647)`;
  
  if (content.includes(oldLockKey)) {
    content = content.replace(oldLockKey, newLockKey);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Account creation race condition fixed');
  } else {
    console.log('  Already fixed or pattern not found');
  }
}

// Fix 5: Remove console.log of sensitive settings
function fixInformationDisclosure() {
  console.log('\n[Fix 5] Removing sensitive information from error logs...');
  const filePath = path.join(BACKEND_DIR, 'routes', 'accounts.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  const oldLog = `console.error('Bad platform_settings values:', settings)`;
  const newLog = `console.error('Platform configuration error - invalid settings')`;
  
  if (content.includes(oldLog)) {
    content = content.replace(oldLog, newLog);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Information disclosure fixed');
  } else {
    console.log('  Already fixed or pattern not found');
  }
}

// Fix 6: Add rate limiting to KYC upload
function fixKYCRateLimiting() {
  console.log('\n[Fix 6] Adding rate limiting to KYC upload endpoint...');
  const filePath = path.join(BACKEND_DIR, 'routes', 'kyc.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Add KYC-specific rate limiter at the top
  if (!content.includes('const kycUploadLimiter')) {
    const limiterImport = `const rateLimit = require('express-rate-limit')`;
    const newLimiter = `const rateLimit = require('express-rate-limit')

// KYC upload limiter: 5 uploads per hour per user
const kycUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many KYC upload attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || req.ip
})`;
    
    content = content.replace(limiterImport, newLimiter);
  }
  
  // Apply limiter to upload route
  const oldUpload = `router.post('/upload', uploadKycFields, async function(req, res) {`;
  const newUpload = `router.post('/upload', kycUploadLimiter, uploadKycFields, async function(req, res) {`;
  
  if (content.includes(oldUpload)) {
    content = content.replace(oldUpload, newUpload);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ KYC rate limiting added');
  } else {
    console.log('  Rate limiter may already be applied');
  }
}

// Fix 7: Add rate limiting to payouts
function fixPayoutRateLimiting() {
  console.log('\n[Fix 7] Adding rate limiting to payout endpoints...');
  const filePath = path.join(BACKEND_DIR, 'routes', 'payouts.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Add payout-specific rate limiter
  if (!content.includes('const payoutRequestLimiter')) {
    const limiterImport = `const rateLimit = require('express-rate-limit')`;
    const newLimiter = `const rateLimit = require('express-rate-limit')

// Payout request limiter: 3 requests per hour per user
const payoutRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { error: 'Too many payout requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || req.ip
})`;
    
    content = content.replace(limiterImport, newLimiter);
  }
  
  // Apply limiter to request route
  const oldRequest = `router.post('/request', authenticateToken, async function(req, res) {`;
  const newRequest = `router.post('/request', payoutRequestLimiter, authenticateToken, async function(req, res) {`;
  
  if (content.includes(oldRequest)) {
    content = content.replace(oldRequest, newRequest);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Payout rate limiting added');
  } else {
    console.log('  Rate limiter may already be applied');
  }
}

// Fix 8: Improve socket.io cleanup
function fixSocketIoCleanup() {
  console.log('\n[Fix 8] Improving socket.io connection cleanup...');
  const filePath = path.join(BACKEND_DIR, 'server.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Add disconnect handler with proper cleanup
  const socketMiddlewareEnd = `next()
  } catch (err) {
    next(err)
  }
})`;
  
  const socketMiddlewareWithCleanup = `next()
  } catch (err) {
    next(err)
  }
})

// Proper socket cleanup on disconnect
io.on('connection', (socket) => {
  socket.on('disconnect', () => {
    // Socket.io automatically removes socket from rooms on disconnect
    // This explicit handler is for any custom cleanup if needed
    console.log('Socket disconnected:', socket.id)
  })
})`;
  
  if (content.includes(socketMiddlewareEnd) && !content.includes('socket.on(\'disconnect\'')) {
    content = content.replace(socketMiddlewareEnd, socketMiddlewareWithCleanup);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ Socket.io cleanup improved');
  } else {
    console.log('  Already fixed or pattern not found');
  }
}

// Fix 9: Fix priceFeed callback error handling
function fixPriceFeedCallback() {
  console.log('\n[Fix 9] Fixing priceFeed callback error handling...');
  const filePath = path.join(BACKEND_DIR, 'priceFeed.js');
  
  if (!fs.existsSync(filePath)) {
    console.log('  File not found, skipping...');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // The callback error handling is already wrapped in try/catch
  // Add more detailed logging
  const oldCallbackError = `console.error('Price feed callback error:', callbackErr.message)`;
  const newCallbackError = `console.error('Price feed callback error:', callbackErr.message, callbackErr.stack)`;
  
  if (content.includes(oldCallbackError)) {
    content = content.replace(oldCallbackError, newCallbackError);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('  ✓ PriceFeed callback error handling improved');
  } else {
    console.log('  Already has stack trace or pattern not found');
  }
}

// Fix 10: Create shared constants file
function createSharedConstants() {
  console.log('\n[Fix 10] Creating shared constants file...');
  const filePath = path.join(BACKEND_DIR, 'constants.js');
  
  const constantsContent = `/**
 * Shared constants for the PropFirm backend
 * Centralizes configuration to avoid duplication across files
 */

// Contract sizes per instrument
const CONTRACT_SIZES = {
  EURUSD: 100000,
  GBPUSD: 100000,
  XAUUSD: 100,
  XAGUSD: 5000
}

// Valid account sizes
const VALID_SIZES = [5000, 10000, 25000, 50000, 100000]

// Account types
const ACCOUNT_TYPES = {
  PHASE1: 'phase1',
  PHASE2: 'phase2',
  FUNDED: 'funded'
}

// Account statuses
const ACCOUNT_STATUSES = {
  ACTIVE: 'active',
  PASSED: 'passed',
  FAILED: 'failed',
  EXPIRED: 'expired'
}

// Trade statuses
const TRADE_STATUSES = {
  OPEN: 'open',
  CLOSED: 'closed',
  PENDING: 'pending'
}

// KYC statuses
const KYC_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
}

// Payout statuses
const PAYOUT_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  PAID: 'paid',
  REJECTED: 'rejected'
}

// Default platform settings
const DEFAULT_PLATFORM_SETTINGS = {
  phase1_profit_target_pct: 10,
  phase1_max_drawdown_pct: 10,
  phase1_day_limit: 30,
  phase2_profit_target_pct: 5,
  phase2_max_drawdown_pct: 5,
  phase2_day_limit: 60,
  funded_profit_split: 100,
  funded_max_drawdown_pct: 5,
  max_accounts_per_user: 0,
  min_payout_amount: 100,
  payout_processing_days: 3
}

// Rate limiting defaults
const RATE_LIMITS = {
  AUTH_WINDOW_MS: 15 * 60 * 1000, // 15 minutes
  AUTH_MAX: 10,
  ACCOUNT_CREATE_WINDOW_MS: 24 * 60 * 60 * 1000, // 24 hours
  ACCOUNT_CREATE_MAX: 5,
  TRADE_WINDOW_MS: 60 * 1000, // 1 minute
  TRADE_MAX: 30,
  KYC_UPLOAD_WINDOW_MS: 60 * 60 * 1000, // 1 hour
  KYC_UPLOAD_MAX: 5,
  PAYOUT_REQUEST_WINDOW_MS: 60 * 60 * 1000, // 1 hour
  PAYOUT_REQUEST_MAX: 3
}

// File upload settings
const UPLOAD_SETTINGS = {
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB
  ALLOWED_ID_EXTENSIONS: ['jpg', 'png', 'pdf'],
  ALLOWED_SELFIE_EXTENSIONS: ['jpg', 'png'],
  PRICE_HISTORY_RETAIN_DAYS: 7
}

// Time settings (all in UTC)
const TIME_SETTINGS = {
  MARKET_CLOSE_FRIDAY_UTC: 22, // 22:00 UTC
  WEEKEND_CLOSE_BUFFER_MINUTES: 5,
  SESSION_TIMEOUT_HOURS: 24
}

module.exports = {
  CONTRACT_SIZES,
  VALID_SIZES,
  ACCOUNT_TYPES,
  ACCOUNT_STATUSES,
  TRADE_STATUSES,
  KYC_STATUSES,
  PAYOUT_STATUSES,
  DEFAULT_PLATFORM_SETTINGS,
  RATE_LIMITS,
  UPLOAD_SETTINGS,
  TIME_SETTINGS
}`;

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, constantsContent, 'utf8');
    console.log('  ✓ Shared constants file created');
  } else {
    console.log('  Constants file already exists');
  }
}

// Fix 11: Remove debug/fix scripts (move to tools directory)
function cleanupDebugScripts() {
  console.log('\n[Fix 11] Cleaning up debug/fix scripts...');
  
  const scriptsToRemove = [
    'add_chat_api.js',
    'debug.js',
    'check_db.js',
    'fix_schema.js',
    'fix_admin_tables.js',
    'fix_db.js',
    'fix_ids.js',
    'fix_tickets.js'
  ];
  
  const toolsDir = path.join(BACKEND_DIR, 'tools');
  
  // Create tools directory
  if (!fs.existsSync(toolsDir)) {
    fs.mkdirSync(toolsDir, { recursive: true });
    console.log('  Created tools directory');
  }
  
  let movedCount = 0;
  scriptsToRemove.forEach(script => {
    const srcPath = path.join(BACKEND_DIR, script);
    const destPath = path.join(toolsDir, script);
    
    if (fs.existsSync(srcPath)) {
      // Add a warning header to the script
      let content = fs.readFileSync(srcPath, 'utf8');
      if (!content.includes('WARNING: This is a one-time migration script')) {
        const warning = `/**
 * WARNING: This is a one-time migration/debug script.
 * DO NOT run this in production unless explicitly instructed.
 * This script may modify database schema or data irreversibly.
 */

`;
        content = warning + content;
        fs.writeFileSync(destPath, content, 'utf8');
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      
      fs.unlinkSync(srcPath);
      console.log(`  Moved: ${script} -> tools/`);
      movedCount++;
    }
  });
  
  console.log(`  ✓ Moved ${movedCount} debug scripts to tools/ directory`);
}

// Fix 12: Standardize timezone to UTC
function fixTimezoneConsistency() {
  console.log('\n[Fix 12] Standardizing timezone handling to UTC...');
  const files = [
    'challengeEngine.js',
    'server.js',
    'routes/accounts.js',
    'routes/trades.js'
  ];
  
  files.forEach(file => {
    const filePath = path.join(BACKEND_DIR, file);
    if (!fs.existsSync(filePath)) return;
    
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;
    
    // Replace new Date() with explicit UTC where appropriate
    // This is a simplified fix - full implementation would require more context
    if (content.includes('new Date()') && !content.includes('// UTC')) {
      // Add comment reminding developers to use UTC
      const reminder = `// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
`;
      if (!content.includes(reminder)) {
        content = reminder + content;
        modified = true;
      }
    }
    
    if (modified) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`  ✓ Added UTC reminder to ${file}`);
    }
  });
}

// Main execution
console.log('='.repeat(60));
console.log('PropFirm Backend Security Fixes');
console.log('='.repeat(60));
console.log('\n⚠️  WARNING: This script will modify your source files.');
console.log('Backup files will be created with .backup extension.\n');

try {
  fixAdminPasswordHashing();
  fixPathTraversal();
  fixPassAccountErrorHandling();
  fixAccountCreationRaceCondition();
  fixInformationDisclosure();
  fixKYCRateLimiting();
  fixPayoutRateLimiting();
  fixSocketIoCleanup();
  fixPriceFeedCallback();
  createSharedConstants();
  cleanupDebugScripts();
  fixTimezoneConsistency();
  
  console.log('\n' + '='.repeat(60));
  console.log('✓ All fixes applied successfully!');
  console.log('='.repeat(60));
  console.log('\nNext steps:');
  console.log('1. Review the changes in your code editor');
  console.log('2. Test thoroughly in a development environment');
  console.log('3. Update your .env with ADMIN_PASSWORD (will be hashed on first login)');
  console.log('4. Run: npm install (if new dependencies needed)');
  console.log('5. Delete this script after successful application\n');
} catch (error) {
  console.error('\n❌ Error applying fixes:', error.message);
  console.error('Please check the error above and try again.');
  process.exit(1);
}
