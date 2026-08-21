/**
 * Shared type definitions for the money models.
 *
 * ── Why JSDoc and not TypeScript files ───────────────────────────────────────
 *
 * `tsconfig.json` runs with `checkJs`, so these `@typedef`s are enforced by
 * `npm run typecheck` exactly as an interface in a .ts file would be — without
 * renaming a single module or splitting the tree between .jsx and .tsx.
 *
 * ── Why the money fields are strings ─────────────────────────────────────────
 *
 * Prices, lots and balances arrive from the API as decimal STRINGS and are
 * handled with decimal.js (see utils/finance.js). Typing them as `number` would
 * make `Number(lots)` look correct to the compiler while quietly reintroducing
 * the binary-float error the Decimal layer exists to prevent — 0.1 + 0.2 on a
 * balance is a real defect, not a rounding curiosity. The type says string so
 * that anything doing arithmetic has to go through `toDecimal` first.
 *
 * Computed, display-only values that never feed further arithmetic (floating
 * P&L as rendered, percentages) are `number`, because that is what they are by
 * the time a component receives them.
 *
 * This file exports nothing at runtime; it exists to be imported by
 * `@typedef {import('../types.js').TradePosition}` from the modules that use it.
 */

/**
 * An open or pending position.
 *
 * @typedef {object} TradePosition
 * @property {string} id
 * @property {string} account_id
 * @property {string} symbol            Instrument code, e.g. 'EURUSD'.
 * @property {'BUY'|'SELL'} direction
 * @property {string} lots              Decimal string.
 * @property {string} openPrice         Decimal string.
 * @property {string|null} stopLoss     Decimal string, or null when unset.
 * @property {string|null} takeProfit   Decimal string, or null when unset.
 * @property {number} floatingPnL       Computed for display; not re-used in arithmetic.
 * @property {'open'|'pending'|'closed'} status
 * @property {string} open_time         ISO 8601.
 * @property {string|null} close_time   ISO 8601, or null while open.
 */

/**
 * A challenge or funded account.
 *
 * @typedef {object} Account
 * @property {string} id
 * @property {string} account_uid       Human-facing reference shown in the UI.
 * @property {string} user_id
 * @property {string} starting_balance  Decimal string.
 * @property {string} current_balance   Decimal string.
 * @property {string} profit_target     Decimal string.
 * @property {'active'|'passed'|'failed'|'pending_review'} status
 * @property {number} max_drawdown_pct
 * @property {number} daily_drawdown_limit_pct
 */

/**
 * A live equity snapshot pushed over the socket on each engine tick.
 *
 * @typedef {object} EquitySnapshot
 * @property {number} equity
 * @property {number} floating_pnl
 * @property {number} current_balance
 * @property {number} drawdown_floor
 * @property {number} drawdown_used_pct
 * @property {number} daily_drawdown_used_pct
 * @property {number} daily_drawdown_limit_pct
 * @property {number} profit_remaining
 * @property {number} received_at       Epoch ms, stamped client-side on arrival.
 */

/**
 * One instrument's bid/ask.
 *
 * @typedef {object} PriceTick
 * @property {number} bid
 * @property {number} ask
 * @property {number} [spread]
 */

/**
 * A tradable instrument's static configuration.
 *
 * @typedef {object} Instrument
 * @property {string} symbol
 * @property {'forex'|'metals'|'energies'|'indices'} group
 * @property {number} contractSize
 * @property {number} leverage
 * @property {string} quoteCurrency
 */

/**
 * A withdrawal request.
 *
 * @typedef {object} PayoutRequest
 * @property {string} id
 * @property {string} account_id
 * @property {string} amount_requested  Decimal string.
 * @property {string} amount_payable    Decimal string, after the profit split.
 * @property {number} profit_share_pct
 * @property {'pending'|'approved'|'rejected'|'paid'} status
 * @property {string|null} paid_at      ISO 8601, or null until paid.
 */

export {}
