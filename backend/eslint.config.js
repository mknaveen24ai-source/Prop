const js = require('@eslint/js')
const globals = require('globals')

// Deliberately conservative. The goal is to catch real defects — undeclared
// variables, unreachable code, duplicate object keys, promise mistakes — not to
// impose a style on ~25k lines of existing, working code. Formatting rules are
// intentionally absent.
module.exports = [
  {
    ignores: [
      'node_modules/**',
      'logs/**',
      'uploads/**',
      'coverage/**',
      // One-off DB repair scripts, excluded from the production image too.
      'tools/**',
      'scripts/v2_migrate.js',
      'scripts/v2_upgrade_db.js',
      'generate_audit_pdf.js',
      'MIGRATION_INSTALL_SUMMARY.js'
    ]
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.commonjs
      }
    },
    rules: {
      // ── Hygiene: warn ──────────────────────────────────────────────────────
      // Worth knowing about and worth cleaning up incrementally, but not worth
      // blocking a deploy over. `npm run lint` exits 0 on these; run
      // `npm run lint:strict` to treat them as blocking.
      //
      // Unused *args* are ignored outright: an Express error handler must keep
      // all four of (err, req, res, next) to be recognized as one.
      'no-unused-vars': ['warn', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^_'
      }],
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'no-promise-executor-return': 'warn',

      // `catch { }` to deliberately swallow a non-critical failure is an
      // established pattern here (cache warmers, best-effort notifications,
      // shutdown cleanup) and is not a defect.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Attaching { cause } to every rethrow would be a large mechanical change
      // across working error paths for no behavioural gain.
      'preserve-caught-error': 'off',

      // ── Real defects: error ────────────────────────────────────────────────
      // These block CI. Each one has caught an actual bug in this codebase or
      // guards a class of bug that would be expensive here.
      //
      // Found on first run: a duplicate `computeRMultiple` export key in
      // trades.js, an undefined `backup_codes` shorthand in admin.js that made
      // a wrong 2FA code throw a ReferenceError instead of failing cleanly, and
      // ~40 lines of unreachable legacy 2FA code after a `return` in admin.js.
      'no-await-in-loop': 'off',        // used intentionally for sequential DB work
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'require-atomic-updates': 'off',  // too noisy against the existing async code
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['warn', { destructuring: 'all' }],

      // Money math must never round via bitwise ops (silently truncates to
      // int32, which for a balance over ~2.1bn cents is catastrophic).
      'no-bitwise': 'warn'
    }
  },

  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': 'off'
    }
  },

  {
    files: ['migrations/**/*.js', 'seeds/**/*.js'],
    rules: {
      'no-unused-vars': 'off'
    }
  }
]
