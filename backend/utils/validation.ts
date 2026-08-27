/**
 * Input validation utilities for PropFirm
 * Use these helpers to validate user inputs consistently
 */

// Sanitize string inputs - remove XSS-danger characters but preserve legitimate ones
// FIX (MEDIUM #24): Only strip characters that are actually dangerous for HTML output
// (< and > for script tags). Preserve apostrophes (O'Brien), ampersands (AT&T),
// parentheses, etc. since parameterized queries prevent SQL injection.
type ValidationRuleType = 'string' | 'email' | 'number' | 'boolean'

interface ValidationRule {
  required?: boolean
  default?: unknown
  type: ValidationRuleType
  maxLength?: number
  min?: number
  max?: number
}

type ValidationSchema = Record<string, ValidationRule>

interface ValidationResult {
  sanitized: Record<string, unknown>
  errors: string[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function sanitizeString(str: unknown, maxLength = 500): string {
  if (typeof str !== 'string') return '';
  return str
    .slice(0, maxLength)
    .replace(/</g, '&lt;')  // Escape < for HTML safety
    .replace(/>/g, '&gt;')  // Escape > for HTML safety
    .trim();
}

// Validate email format
function isValidEmail(email: unknown): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(String(email).toLowerCase());
}

// Validate phone number (basic international format)
function isValidPhone(phone: unknown): boolean {
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(String(phone).replace(/[\s\-()]/g, ''));
}

// Validate country code
function isValidCountry(country: unknown): boolean {
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
function isValidNumber(
  value: unknown,
  min: number,
  max: number,
  allowDecimal = true
): boolean {
  const raw = String(value).trim();
  if (!raw) return false;

  const numberRegex = allowDecimal
    ? /^[+-]?\d+(\.\d+)?$/
    : /^[+-]?\d+$/;

  if (!numberRegex.test(raw)) return false;

  const num = Number(raw);
  return Number.isFinite(num) && num >= min && num <= max;
}

// Validate lot size (0.01 to 1000 in steps of 0.01)
function isValidLotSize(lotSize: unknown): boolean {
  const lot = parseFloat(String(lotSize));
  if (isNaN(lot) || lot < 0.01 || lot > 1000) return false;
  return Math.round(lot * 100) % 1 === 0; // Must be in 0.01 increments
}

// Validate password strength
function isValidPassword(password: unknown): boolean {
  if (typeof password !== 'string' || password.length < 8) return false;
  // At least 8 chars, 1 uppercase, 1 lowercase, 1 number
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
  return passwordRegex.test(password);
}

// Validate UUID format
function isValidUUID(uuid: unknown): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(String(uuid));
}

// Sanitize and validate object properties
function validateObject(obj: unknown, schema: ValidationSchema): ValidationResult {
  const source = asRecord(obj)
  const errors: string[] = [];
  const sanitized: Record<string, unknown> = {};
  
  for (const [key, rules] of Object.entries(schema)) {
    const value = source[key];
    
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`${key} is required`);
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
      // FIX (BUG-M4): renamed local var from 'sanitized' to 'sanitizedEmail' to
      // prevent it shadowing the outer 'sanitized' object. The old code's
      // `sanitized[key] = sanitized` assigned a string property to itself (no-op).
      const sanitizedEmail = sanitizeString(String(value), 255);
      if (!isValidEmail(sanitizedEmail)) {
        errors.push(`${key} must be a valid email`);
      } else {
        sanitized[key] = sanitizedEmail;
      }
    } else if (rules.type === 'number') {
      const num = parseFloat(String(value));
      if (isNaN(num)) {
        errors.push(`${key} must be a number`);
      } else if (rules.min !== undefined && num < rules.min) {
        errors.push(`${key} must be at least ${rules.min}`);
      } else if (rules.max !== undefined && num > rules.max) {
        errors.push(`${key} must be at most ${rules.max}`);
      } else {
        sanitized[key] = num;
      }
    } else if (rules.type === 'boolean') {
      sanitized[key] = value === true || value === 'true' || value === 1;
    }
  }
  
  return { sanitized, errors };
}

export {
  sanitizeString,
  isValidEmail,
  isValidPhone,
  isValidCountry,
  isValidNumber,
  isValidLotSize,
  isValidPassword,
  isValidUUID,
  validateObject
};
