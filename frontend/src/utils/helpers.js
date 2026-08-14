import {
  calculatePnL as calculateInstrumentPnL,
  calculateMargin as calculateInstrumentMargin,
} from './instruments.js'

/**
 * @typedef {Object} User
 * @property {string} id - User UUID
 * @property {string} email - User email address
 * @property {string} full_name - User full name
 * @property {string} kyc_status - KYC status: 'pending' | 'approved' | 'rejected'
 * @property {boolean} is_banned - Whether user is banned
 * @property {string} created_at - Account creation timestamp
 */

/**
 * @typedef {Object} Account
 * @property {string} id - Account UUID
 * @property {string} user_id - Owner user ID
 * @property {string} account_type - 'phase1' | 'phase2' | 'funded'
 * @property {number} account_size - Account size in USD
 * @property {number} current_balance - Current balance
 * @property {number} starting_balance - Starting balance
 * @property {number} peak_balance - Highest balance reached
 * @property {string} status - 'active' | 'passed' | 'failed' | 'expired' | 'locked'
 * @property {number} profit_target - Profit target in USD
 * @property {number} max_drawdown_pct - Maximum drawdown percentage
 * @property {number} current_drawdown_pct - Current drawdown percentage
 * @property {string} created_at - Creation timestamp
 * @property {string} phase_end_date - Phase end date (ISO string)
 */

/**
 * @typedef {Object} Trade
 * @property {string} id - Trade UUID
 * @property {string} account_id - Account ID
 * @property {string} instrument - Trading instrument (e.g., 'EURUSD')
 * @property {'buy' | 'sell'} direction - Trade direction
 * @property {number} lot_size - Lot size
 * @property {number} open_price - Entry price
 * @property {number|null} stop_loss - Stop loss price
 * @property {number|null} take_profit - Take profit price
 * @property {'open' | 'closed' | 'pending'} status - Trade status
 * @property {number|null} demo_pnl - PnL for closed trades
 * @property {string} open_time - Open timestamp (ISO string)
 * @property {string|null} close_time - Close timestamp (ISO string)
 * @property {string|null} close_reason - Reason for closing
 */

/**
 * @typedef {Object} Price
 * @property {string} instrument - Instrument name
 * @property {number} bid - Bid price
 * @property {number} ask - Ask price
 * @property {string} updated_at - Last update timestamp
 */

/**
 * @typedef {Object} Payout
 * @property {string} id - Payout UUID
 * @property {string} user_id - User ID
 * @property {string} account_id - Account ID
 * @property {number} amount_requested - Requested amount
 * @property {number} amount_payable - Payable amount (after profit split)
 * @property {string} payment_method - Payment method
 * @property {string} payment_details - Payment details
 * @property {'pending' | 'approved' | 'paid' | 'rejected'} status - Payout status
 * @property {boolean} is_flagged - Whether payout is flagged for review
 * @property {string|null} flag_reason - Flag reason if flagged
 * @property {string} requested_at - Request timestamp
 */

/**
 * @typedef {Object} Notification
 * @property {string} id - Notification ID
 * @property {string} type - Notification type
 * @property {string} message - Notification message
 * @property {string} level - 'info' | 'warning' | 'error' | 'success'
 * @property {boolean} read - Whether notification has been read
 * @property {string} created_at - Creation timestamp
 */

/**
 * Calculate profit and loss for a trade
 * @param {'buy' | 'sell'} direction - Trade direction
 * @param {number} openPrice - Entry price
 * @param {number} currentPrice - Current/exist price
 * @param {number} lots - Lot size
 * @param {string} instrument - Instrument name
 * @returns {number} PnL in USD
 */
export function calculatePnL(direction, openPrice, currentPrice, lots, instrument) {
  return calculateInstrumentPnL(direction, openPrice, currentPrice, lots, instrument)
}

/**
 * Calculate required margin for a trade
 * @param {string} instrument - Instrument name
 * @param {number} lots - Lot size
 * @returns {number} Required margin in USD
 */
export function calculateMargin(instrument, lots) {
  return calculateInstrumentMargin(instrument, lots)
}

/**
 * Get status color for display — single source of truth is ACCOUNT_STATUSES
 * in utils/constants.js; re-exported here so existing imports keep working.
 * @param {string} status - Status value
 * @returns {string} CSS color value
 */
export { getStatusColor } from './constants.js'

/**
 * Format currency for display
 * @param {number} amount - Amount to format
 * @param {string} [currency='USD'] - Currency code
 * @returns {string} Formatted currency string
 */
export function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount)
}

/**
 * Format percentage for display
 * @param {number} value - Percentage value
 * @param {number} [decimals=2] - Decimal places
 * @returns {string} Formatted percentage string
 */
export function formatPercentage(value, decimals = 2) {
  return `${value.toFixed(decimals)}%`
}

/**
 * Format date for display
 * @param {string|Date} date - Date to format
 * @param {string} [locale='en-US'] - Locale string
 * @returns {string} Formatted date string
 */
export function formatDate(date, locale = 'en-US') {
  return new Date(date).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Calculate drawdown percentage
 * @param {number} currentBalance - Current balance
 * @param {number} peakBalance - Peak balance
 * @param {number} startingBalance - Starting balance
 * @returns {number} Drawdown percentage
 */
export function calculateDrawdown(currentBalance, peakBalance, startingBalance) {
  const base = Math.max(peakBalance, startingBalance)
  if (base <= 0) return 0
  const drawdown = (base - currentBalance) / base * 100
  return Math.min(100, Math.max(0, parseFloat(drawdown.toFixed(2))))
}

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} Whether email is valid
 */
export function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function isValidPassword(password) {
  const errors = []
  
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters')
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number')
  }
  
  return { valid: errors.length === 0, errors }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Debounce function
 * @template {Function} T
 * @param {T} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {T} Debounced function
 */
export function debounce(func, wait) {
  let timeout
  return function executedFunction(...args) {
    return new Promise((resolve, reject) => {
      const later = () => {
        clearTimeout(timeout)
        try {
          // FIX (MEDIUM #18): Return the result of the debounced function
          // so it can be used with async/await and Promise chains.
          resolve(func.apply(this, args))
        } catch (error) {
          reject(error)
        }
      }
      clearTimeout(timeout)
      timeout = setTimeout(later, wait)
    })
  }
}

/**
 * Copy text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} Success status
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for older browsers
    const textArea = document.createElement('textarea')
    textArea.value = text
    document.body.appendChild(textArea)
    textArea.select()
    document.execCommand('copy')
    document.body.removeChild(textArea)
    return true
  }
}
