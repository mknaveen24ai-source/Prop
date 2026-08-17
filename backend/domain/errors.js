/**
 * Domain errors.
 *
 * Deliberately the same shape as BalanceAdjustmentError
 * (utils/balanceAdjustments.js): a `message` and a `statusCode`, so route
 * handlers that already do `err.statusCode || 500` keep working unchanged as
 * call sites migrate onto the aggregates.
 */

class DomainError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.name = 'DomainError'
    this.statusCode = statusCode
  }
}

/** A command was refused because the aggregate's current state forbids it. */
class InvariantViolation extends DomainError {
  constructor(message, statusCode = 409) {
    super(message, statusCode)
    this.name = 'InvariantViolation'
  }
}

/** The aggregate could not be loaded. */
class NotFound extends DomainError {
  constructor(message = 'Not found') {
    super(message, 404)
    this.name = 'NotFound'
  }
}

module.exports = { DomainError, InvariantViolation, NotFound }
