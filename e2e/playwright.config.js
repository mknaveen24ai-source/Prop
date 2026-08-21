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
      //
      // Needs a RUNNING STACK, which is why it stayed unwired in CI for so
      // long: the e2e job builds Storybook and nothing else. The `responsive`
      // project below covers the same ground without a backend and is the one
      // that gates every commit; this stays the deeper check against real
      // routes and real data.
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      grep: /@mobile/
    },
    {
      // Viewport matrix over the layout surfaces, against the Storybook build.
      //
      // Unlike `visual` this asserts GEOMETRY, not pixels -- scrollWidth against
      // clientWidth, bounding boxes against --touch-min -- so it is not hostage
      // to font rasterisation and needs no pinned container. That means it runs
      // on a developer's machine as readily as in CI, which matters: a check
      // that only ever runs in CI is one people find out they have broken at
      // the worst possible moment.
      //
      // Each test sets its own viewport from the device matrix in
      // frontend/src/styles/breakpoints.js, so nothing is fixed here.
      name: 'responsive',
      grep: /@responsive/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.STORYBOOK_URL || 'http://localhost:6006',
        // Touch emulation, so `@media (pointer: coarse)` -- which is what
        // raises the controls to 44px -- actually applies. Without it the tap
        // target assertions measure the desktop density and fail for a reason
        // that has nothing to do with a phone.
        hasTouch: true,
        isMobile: false,
        deviceScaleFactor: 1
      }
    },
    {
      // Automated WCAG scan (axe-core) over the real app rather than Storybook:
      // page title, landmark structure, heading order and cross-component
      // contrast only exist once a page is assembled, and a component-level
      // scan cannot see any of them.
      //
      // Its own project because it points at the APP (E2E_BASE_URL), while
      // `responsive` and `visual` point at a Storybook build. Running under the
      // default `chromium` project would make it inherit whichever baseURL that
      // happened to have.
      //
      // The public block needs only a served frontend. The trader and admin
      // blocks skip unless E2E_EMAIL / E2E_ADMIN_EMAIL are set, so this is
      // useful locally without a seeded database and complete in the `a11y` CI
      // job, which provisions one.
      name: 'a11y',
      grep: /@a11y/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000'
      }
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
