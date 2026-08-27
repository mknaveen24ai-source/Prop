// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { createRequire } from 'node:module'

// Local rules live in eslint-rules/. CommonJS, because that is what the ESLint
// rule API expects, and this config file is an ES module.
const require = createRequire(import.meta.url)
const designTokens = require('./eslint-rules/design-tokens.js')

// Same philosophy as backend/eslint.config.js: real defects are errors and
// block CI; hygiene is a warning and cleaned up incrementally. No formatting
// rules — this codebase is ~37k lines and reformatting it would bury the diff.
export default [{
  ignores: [
    'node_modules/**',
    'build/**',
    'dist/**',
    'coverage/**',
    'public/**',
    // Storybook's build output: thousands of minified bundles. Linting it
    // reported 10,598 errors and 10,390 warnings -- almost all prefer-const and
    // no-var against minified vendor code -- which buried the real ones.
    'storybook-static/**'
  ]
}, js.configs.recommended, {
  // The service-worker template. Not ignored -- it ships as executable code and
  // deserves the same linting as anything else -- but it runs in a worker
  // scope, and `__PRECACHE_MANIFEST__` is a placeholder that
  // `offlineShellPlugin` substitutes at build time, so it is legitimately
  // undefined in source.
  files: ['sw-template.js'],
  languageOptions: {
    globals: { ...globals.serviceworker, __PRECACHE_MANIFEST__: 'readonly' }
  }
}, {
  // Node-side tooling: the drift counter, the codemods, the shared token
  // config and the local ESLint rules. These are CommonJS and run under Node,
  // so `require`, `module` and `__dirname` are defined -- linting them against
  // browser globals reported six no-undef errors for correct code.
  files: ['scripts/**/*.js', 'eslint-rules/**/*.js', 'design-tokens.config.js'],
  languageOptions: {
    sourceType: 'commonjs',
    globals: { ...globals.node }
  }
}, {
  files: ['**/*.{ts,tsx}'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname
    },
    globals: {
      ...globals.browser,
      ...globals.es2021
    }
  },
  plugins: {
    '@typescript-eslint': tseslint.plugin
  },
  rules: {
    'no-undef': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    '@typescript-eslint/ban-ts-comment': ['error', {
      'ts-ignore': true,
      'ts-nocheck': true,
      'ts-check': false,
      'ts-expect-error': 'allow-with-description',
      minimumDescriptionLength: 10
    }],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/only-throw-error': 'error'
  }
}, {
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
    'react-hooks': reactHooks,
    'design-tokens': designTokens
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
    // ignoreRestSiblings: `const { voucher, ...rest } = p` is the idiomatic
    // way to omit a key, and the omitted binding is the whole point of
    // writing it. Flagging it made the rule report a false positive on
    // correct code, which is how a warning list stops being read.
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'react-hooks/exhaustive-deps': 'warn',
    'no-useless-escape': 'warn',
    'prefer-const': ['warn', { destructuring: 'all' }],

    // ── Design-token drift: warn ────────────────────────────────────────────
    // Hygiene by the definition above, so warnings rather than errors. The
    // ceiling in `npm run design:drift:ci` is what stops the count growing;
    // these exist so the feedback arrives in the editor, before a value is
    // written down, rather than in CI after the fact.
    //
    // Both these rules and scripts/design-drift.js read the scales out of
    // styles/tokens.css. Neither keeps its own copy: a checker holding a
    // private copy of the scale can be wrong in exactly the way the brief
    // behind this work was wrong -- it called --space-3 16px when it is 12px
    // -- while still reporting full marks.
    'design-tokens/no-hardcoded-spacing': 'warn',
    'design-tokens/no-hardcoded-font-size': 'warn',
    'design-tokens/no-hardcoded-color': 'warn',

    // ── React Compiler-era rules: warn ──────────────────────────────────────
    // These ship as errors in eslint-plugin-react-hooks v6+ and describe what
    // the React Compiler needs to auto-memoize. They are aspirational for a
    // codebase written before the compiler existed: ~120 hits here, none of
    // which is a live bug. Kept visible as warnings so new code trends the
    // right way, without blocking a deploy on a pre-existing pattern.
    // Data-fetch, camera, socket and polling effects intentionally update
    // loading/result state. The compiler rule cannot distinguish those
    // external synchronisations from avoidable derived-state effects and was
    // reporting 88 false positives. Genuine derived state is handled during
    // render; Rules of Hooks and exhaustive-deps remain enforced separately.
    'react-hooks/set-state-in-effect': 'off',
    'react-hooks/refs': 'warn',
    'react-hooks/purity': 'warn',
    'react-hooks/immutability': 'warn',
    'react-hooks/static-components': 'warn',
    'react-hooks/preserve-manual-memoization': 'warn'
  }
}, {
  files: ['**/*.test.{js,jsx}', 'src/setupTests.js'],
  languageOptions: {
    globals: { ...globals.browser, ...globals.node, ...globals.vitest }
  },
  rules: {
    'no-unused-vars': 'off',
    // These tests intentionally exercise raw colour literals and contrast
    // parsing. Replacing the fixtures with theme tokens would stop testing the
    // parser and WCAG calculations they exist to cover.
    'design-tokens/no-hardcoded-color': 'off'
  }
}, {
  // Node-side ESM tooling.
  files: ['vite.config.mjs', 'eslint.config.mjs'],
  languageOptions: {
    sourceType: 'module',
    globals: { ...globals.node }
  }
}, {
  // Node-side CommonJS build scripts (require/__dirname/process).
  files: ['scripts/**/*.js'],
  languageOptions: {
    sourceType: 'commonjs',
    globals: { ...globals.node }
  }
}, ...storybook.configs["flat/recommended"]];
