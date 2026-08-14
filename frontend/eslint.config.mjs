import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

// Same philosophy as backend/eslint.config.js: real defects are errors and
// block CI; hygiene is a warning and cleaned up incrementally. No formatting
// rules — this codebase is ~37k lines and reformatting it would bury the diff.
export default [
  {
    ignores: [
      'node_modules/**',
      'build/**',
      'dist/**',
      'coverage/**',
      'public/**'
    ]
  },

  js.configs.recommended,

  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: {
        ...globals.browser,
        ...globals.es2021
      }
    },
    plugins: {
      react,
      'react-hooks': reactHooks
    },
    settings: {
      react: { version: 'detect' }
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // The new JSX transform means React need not be in scope, and prop-types
      // are not used anywhere in this codebase.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Cosmetic: 38 hits for apostrophes in copy. Not a defect.
      'react/no-unescaped-entities': 'off',
      'react/no-unknown-property': 'error',

      // ── Real defects: error ─────────────────────────────────────────────────
      // no-undef caught the one that mattered: ErrorBoundary.jsx referenced
      // `process.env.NODE_ENV`, which Vite does not shim in the browser (CRA
      // did). The fallback UI therefore threw ReferenceError while handling
      // another component's error, unmounting the whole tree to a white screen.
      'react-hooks/rules-of-hooks': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unreachable-loop': 'error',
      'no-dupe-keys': 'error',
      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',

      // ── Hygiene: warn ───────────────────────────────────────────────────────
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'react-hooks/exhaustive-deps': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],

      // ── React Compiler-era rules: warn ──────────────────────────────────────
      // These ship as errors in eslint-plugin-react-hooks v6+ and describe what
      // the React Compiler needs to auto-memoize. They are aspirational for a
      // codebase written before the compiler existed: ~120 hits here, none of
      // which is a live bug. Kept visible as warnings so new code trends the
      // right way, without blocking a deploy on a pre-existing pattern.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn'
    }
  },

  {
    files: ['**/*.test.{js,jsx}', 'src/setupTests.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.vitest }
    },
    rules: {
      'no-unused-vars': 'off'
    }
  },

  {
    // Node-side ESM tooling.
    files: ['vite.config.mjs', 'eslint.config.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },

  {
    // Node-side CommonJS build scripts (require/__dirname/process).
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  }
]
