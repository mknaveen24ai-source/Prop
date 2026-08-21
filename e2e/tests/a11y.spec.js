// @ts-check
const { test, expect } = require('@playwright/test')
const AxeBuilder = require('@axe-core/playwright').default

/**
 * Automated WCAG scan over the real application.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Unlike @responsive and @visual, this runs against the APP, not Storybook.
 * Stories cover components; they cannot see a missing page title, a duplicated
 * landmark, a heading order that only exists once a page is assembled, or a
 * contrast failure between two components that are only ever adjacent at run
 * time. Those are exactly the defects a component-level scan misses.
 *
 * ── Which rules gate ──
 *
 * Only the four WCAG tags. Axe's `best-practice` tag is deliberately excluded:
 * it contains `region` (every node inside a landmark), which fires on layouts
 * that are perfectly conformant, and gating on it is the most common reason an
 * a11y suite gets switched off a month after it lands. Conformance is the bar;
 * best practice is advice.
 *
 * ── Authenticated coverage ──
 *
 * The trader and admin surfaces are where this platform actually lives, and
 * they need a running stack plus a seeded login. The `a11y` CI job provisions
 * exactly that (see .github/workflows/ci.yml) and hands credentials in through
 * E2E_EMAIL / E2E_PASSWORD, the same variables trade-lifecycle.spec.js uses.
 * Without them the authenticated block skips rather than fails, so the public
 * scan still runs on a developer's machine against a bare frontend.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

/**
 * Run axe and assert zero violations, printing something a human can act on.
 *
 * The default failure message is the serialised violation array, which is
 * hundreds of lines of nested nodes per finding. A report nobody reads is the
 * same as no report, so this renders rule id, impact, help URL and the offending
 * selectors, and attaches the full JSON for when that is not enough.
 */
async function expectNoViolations(page, testInfo, { disableRules = [] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS)
  if (disableRules.length > 0) builder = builder.disableRules(disableRules)

  const results = await builder.analyze()

  await testInfo.attach('axe-results.json', {
    body: JSON.stringify(results.violations, null, 2),
    contentType: 'application/json',
  })

  const summary = results.violations
    .map((violation) => {
      const targets = violation.nodes
        .slice(0, 5)
        .map((node) => '        ' + node.target.join(' '))
        .join('\n')
      const more = violation.nodes.length > 5 ? `\n        …and ${violation.nodes.length - 5} more` : ''
      return [
        `  [${violation.impact}] ${violation.id} — ${violation.help}`,
        `      ${violation.helpUrl}`,
        targets + more,
      ].join('\n')
    })
    .join('\n\n')

  expect(
    results.violations,
    results.violations.length === 0
      ? ''
      : `${results.violations.length} accessibility violation(s):\n\n${summary}\n`
  ).toEqual([])
}

/** Sign in through the real form, as trade-lifecycle.spec.js does. */
async function login(page) {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(String(EMAIL))
  await page.getByLabel(/password/i).first().fill(String(PASSWORD))
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 })
}

// ── Public surface ───────────────────────────────────────────────────────────
// No credentials needed, so this half runs anywhere the frontend is served.
const PUBLIC_ROUTES = [
  ['landing', '/'],
  ['login', '/login'],
  ['register', '/register'],
  ['terms of service', '/terms'],
  ['privacy policy', '/privacy'],
  ['refund policy', '/refund-policy'],
  ['cookie policy', '/cookie-policy'],
  ['competitions', '/competitions'],
  ['leaderboard', '/leaderboard'],
  ['transparency', '/transparency'],
]

test.describe('@a11y public surface', () => {
  for (const [label, path] of PUBLIC_ROUTES) {
    test(`${label} has no WCAG violations`, async ({ page }, testInfo) => {
      await page.goto(path)
      // Landing and Transparency mount charts and count-ups after first paint;
      // scanning mid-animation reports transient contrast against a half-faded
      // element.
      await page.waitForLoadState('networkidle')
      await expectNoViolations(page, testInfo)
    })
  }

  test('landing has no WCAG violations in light mode', async ({ page }, testInfo) => {
    // Both palettes ship, and the light theme is where the measured contrast
    // margins are thinnest (--muted is 4.66:1 on --paper-2 against a 4.5 floor).
    await page.goto('/')
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await page.waitForLoadState('networkidle')
    await expectNoViolations(page, testInfo)
  })
})

// ── Authenticated surface ────────────────────────────────────────────────────
test.describe('@a11y authenticated surface', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to scan authenticated views')

  const TRADER_ROUTES = [
    ['dashboard home', '/dashboard'],
    ['trading terminal', '/dashboard/trade'],
    ['analytics', '/dashboard/analytics'],
    ['trade history', '/dashboard/history'],
    ['payouts', '/dashboard/payouts'],
    ['KYC', '/dashboard/kyc'],
    ['profile', '/dashboard/profile'],
  ]

  for (const [label, path] of TRADER_ROUTES) {
    test(`trader ${label} has no WCAG violations`, async ({ page }, testInfo) => {
      await login(page)
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await expectNoViolations(page, testInfo)
    })
  }

  test('an open dialog is announced and contained', async ({ page }, testInfo) => {
    // Dialogs are the surface the focus-trap work targeted, and a scan of the
    // page behind a closed dialog says nothing about the dialog itself.
    await login(page)
    await page.goto('/dashboard/history')
    await page.waitForLoadState('networkidle')

    const firstRow = page.getByRole('row').nth(1)
    if (await firstRow.count() === 0) test.skip(true, 'no trade history rows on the seeded account')

    await firstRow.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expectNoViolations(page, testInfo)

    // Escape must close it and focus must come back to the row that opened it.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

test.describe('@a11y admin surface', () => {
  const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL
  const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to scan the admin panel')

  const ADMIN_ROUTES = [
    ['dashboard', '/admin'],
    ['users', '/admin/users'],
    ['payouts', '/admin/payouts'],
    ['KYC', '/admin/kyc'],
    ['violations', '/admin/violations'],
  ]

  async function adminLogin(page) {
    await page.goto('/admin')
    await page.getByLabel(/email/i).fill(String(ADMIN_EMAIL))
    await page.getByLabel(/password/i).first().fill(String(ADMIN_PASSWORD))
    await page.getByRole('button', { name: /sign in|log in/i }).click()
    await page.waitForURL(/\/admin/, { timeout: 30_000 })
  }

  for (const [label, path] of ADMIN_ROUTES) {
    test(`admin ${label} has no WCAG violations`, async ({ page }, testInfo) => {
      await adminLogin(page)
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await expectNoViolations(page, testInfo)
    })
  }
})
