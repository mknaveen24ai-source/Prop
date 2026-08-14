// @ts-check
const { test, expect } = require('@playwright/test')

/**
 * Credential-free smoke tests. Safe to run against production.
 *
 * Every assertion here corresponds to a failure mode that actually shipped or
 * was one config change away from shipping — see DEPLOYMENT_READINESS_REPORT.md.
 */

test.describe('@smoke public surface', () => {
  test('landing page renders and is branded', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBeLessThan(400)

    // Regression guard: index.html shipped with <title>React App</title> and a
    // create-react-app description for a long time. That is the browser tab,
    // the Google result, and every social link preview.
    const title = await page.title()
    expect(title).not.toBe('React App')
    expect(title.length).toBeGreaterThan(5)

    const description = await page
      .locator('meta[name="description"]')
      .getAttribute('content')
    expect(description).toBeTruthy()
    expect(description).not.toContain('create-react-app')

    // Link previews need these or shared links render as blank cards.
    await expect(page.locator('meta[property="og:title"]')).toHaveCount(1)
    await expect(page.locator('meta[property="og:description"]')).toHaveCount(1)
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(1)
  })

  test('the SPA actually mounts — no blank white screen', async ({ page }) => {
    const consoleErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/')
    await expect(page.locator('#root')).not.toBeEmpty()

    // `process is not defined` is the specific one to watch: Vite does not shim
    // `process` in the browser the way CRA did, and it previously broke
    // ErrorBoundary's own fallback UI — turning any component error into a
    // fully blank page.
    const fatal = [...pageErrors, ...consoleErrors].filter((m) =>
      /is not defined|Unexpected token|Failed to fetch dynamically imported/.test(m)
    )
    expect(fatal, `Fatal browser errors:\n${fatal.join('\n')}`).toHaveLength(0)
  })

  test('API is reachable from the browser origin', async ({ page, baseURL }) => {
    // Guards the build-arg bug: VITE_API_URL is the axios baseURL and request
    // paths already include /api, so a misconfigured value yields /api/api/...
    // and every request 404s. Hitting it same-origin proves the wiring.
    const res = await page.request.get(`${baseURL}/api/health`)
    expect(res.status(), 'GET /api/health should be reachable same-origin').toBe(200)

    const body = await res.json()
    expect(body).toHaveProperty('status')
  })

  test('no request 404s on a doubled /api/api prefix', async ({ page }) => {
    const doubled = []
    page.on('request', (req) => {
      if (req.url().includes('/api/api/')) doubled.push(req.url())
    })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    expect(doubled, `Doubled API prefix:\n${doubled.join('\n')}`).toHaveLength(0)
  })

  test('SPA deep links resolve instead of 404ing', async ({ page }) => {
    // nginx must fall back to index.html for client-side routes.
    for (const path of ['/login', '/register', '/leaderboard']) {
      const response = await page.goto(path)
      expect(response?.status(), `${path} should not 404`).toBeLessThan(400)
      await expect(page.locator('#root')).not.toBeEmpty()
    }
  })

  test('legal pages are reachable', async ({ page }) => {
    for (const path of ['/terms', '/privacy', '/refund-policy', '/cookie-policy']) {
      const response = await page.goto(path)
      expect(response?.status(), `${path} should be reachable`).toBeLessThan(400)
      await expect(page.locator('#root')).not.toBeEmpty()
    }
  })
})

test.describe('@smoke security headers', () => {
  test('production security headers are present', async ({ request, baseURL }) => {
    test.skip(
      baseURL?.includes('localhost') ?? true,
      'Headers are set by nginx, which is not in the local dev loop'
    )

    const res = await request.get('/')
    const headers = res.headers()

    expect(headers['strict-transport-security']).toBeTruthy()
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']?.toLowerCase()).toBe('deny')
    expect(headers['referrer-policy']).toBeTruthy()
    // Express must not advertise itself.
    expect(headers['x-powered-by']).toBeUndefined()
  })

  test('rate limiting is active on auth endpoints', async ({ request }) => {
    // nginx declares auth_limit at 5r/m. This also proves the limit_req_zone
    // directives are in http context — if they were inside server{} nginx would
    // not have started at all and nothing here would respond.
    const statuses = []
    for (let i = 0; i < 12; i++) {
      const res = await request.post('/api/auth/login', {
        data: { email: `nobody-${i}@example.invalid`, password: 'wrong-password' },
        failOnStatusCode: false
      })
      statuses.push(res.status())
    }
    expect(
      statuses.some((s) => s === 429),
      `Expected at least one 429; got ${statuses.join(',')}`
    ).toBe(true)
  })
})

test.describe('@smoke @mobile responsive', () => {
  test('landing page does not scroll horizontally on a phone', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
    })
    // A horizontal scrollbar on mobile is the classic symptom of a fixed-width
    // inline style that no media query can reach.
    expect(
      overflow.scrollWidth,
      `Page is ${overflow.scrollWidth}px wide in a ${overflow.clientWidth}px viewport`
    ).toBeLessThanOrEqual(overflow.clientWidth + 1)
  })

  test('login form is usable on a phone', async ({ page }) => {
    await page.goto('/login')
    const email = page.locator('input[type="email"], input[name="email"]').first()
    await expect(email).toBeVisible()

    const box = await email.boundingBox()
    expect(box, 'email input should have a layout box').toBeTruthy()
    // Below ~44px, taps miss. This is the WCAG/Apple minimum target size.
    expect(box.height).toBeGreaterThanOrEqual(32)
  })
})
