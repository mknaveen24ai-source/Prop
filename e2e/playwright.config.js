// @ts-check
const { defineConfig, devices } = require('@playwright/test')

/**
 * E2E config for the PropFirm platform.
 *
 * These tests run against a *running* stack — they do not start one. Point
 * E2E_BASE_URL at whatever you want to exercise:
 *
 *   local dev:   E2E_BASE_URL=http://localhost:3000  (vite dev + backend on 5000)
 *   compose:     E2E_BASE_URL=https://your-domain.com
 *
 * The suite is deliberately split into two tiers:
 *
 *   @smoke  — no credentials needed. Public surface, security headers, SPA
 *             routing, API health. Safe to run against production.
 *   @auth   — needs E2E_EMAIL / E2E_PASSWORD for a seeded test trader. Skipped
 *             automatically when those are absent, so CI stays green without
 *             secrets configured.
 *
 * Nothing here places a real trade against real money — the trade-lifecycle
 * spec is guarded behind E2E_ALLOW_TRADING=1 and a demo account.
 */
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',

  // A trading UI is full of polling and websockets; give assertions room.
  timeout: 45_000,
  expect: { timeout: 10_000 },

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,

  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Self-signed certs are normal on a staging box.
    ignoreHTTPSErrors: true
  },

  // @visual is opt-in: it needs a Storybook build served somewhere and only
  // produces meaningful results inside the pinned image. Running it by accident
  // from a developer's machine yields a wall of red about font rasterisation.
  grepInvert: process.env.PLAYWRIGHT_PINNED_IMAGE === '1' ? undefined : /@visual/,

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      // The readiness report scored responsive/mobile lowest (18 media queries
      // for 4,600 lines of CSS). This project exists so regressions there are
      // at least visible.
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      grep: /@mobile/
    },
    {
      // Visual regression over the design system, served from a Storybook build
      // rather than the app: stories render fixed content, so the same input
      // produces the same pixels. See tests/visual.spec.js for why that matters.
      //
      // Its own baseURL, because it points at storybook-static rather than at
      // whatever E2E_BASE_URL is aimed at, and a fixed viewport so a screenshot
      // never depends on the window the runner happened to open.
      name: 'visual',
      grep: /@visual/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.STORYBOOK_URL || 'http://localhost:6006',
        viewport: { width: 1280, height: 900 },
        // Baselines are rendered at 1x. A retina runner would otherwise produce
        // images at twice the size and every comparison would fail on
        // dimensions before it ever looked at a pixel.
        deviceScaleFactor: 1
      }
    }
  ]
})
