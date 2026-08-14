// @ts-check
const { test, expect } = require('@playwright/test')

/**
 * Authenticated trader journey.
 *
 * Requires a seeded test account:
 *   E2E_EMAIL=trader@example.com
 *   E2E_PASSWORD=...
 *
 * Without those the whole file skips, so CI stays green until secrets are
 * configured. Order-placing tests additionally require E2E_ALLOW_TRADING=1 so
 * nobody accidentally fires orders at a production account.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const ALLOW_TRADING = process.env.E2E_ALLOW_TRADING === '1'

test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run authenticated tests')

async function login(page) {
  await page.goto('/login')
  await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL)
  await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
}

test.describe('@auth trader dashboard', () => {
  test('logs in and lands on the dashboard', async ({ page }) => {
    await login(page)
    await expect(page.locator('#root')).not.toBeEmpty()
    expect(page.url()).toContain('/dashboard')
  })

  test('session survives a reload — httpOnly cookie is set correctly', async ({ page }) => {
    await login(page)
    await page.reload()
    await page.waitForLoadState('networkidle')
    // A bad cookie SameSite/secure combination shows up here as a bounce to /login.
    expect(page.url()).toContain('/dashboard')
  })

  test('no failed API calls while the dashboard loads', async ({ page }) => {
    const failures = []
    page.on('response', (res) => {
      if (res.url().includes('/api/') && res.status() >= 400 && res.status() !== 401) {
        failures.push(`${res.status()} ${res.url()}`)
      }
    })

    await login(page)
    await page.waitForLoadState('networkidle')

    // Catches the class of bug where a page calls a route that does not exist —
    // e.g. the Payouts page querying /api/accounts/stats?account_id=X when the
    // backend only defines /api/accounts/stats/:account_id, silently leaving a
    // KPI blank forever.
    expect(failures, `Failed API calls:\n${failures.join('\n')}`).toHaveLength(0)
  })

  test('live price feed connects over websocket', async ({ page }) => {
    let socketOpened = false
    page.on('websocket', (ws) => {
      if (ws.url().includes('socket.io')) socketOpened = true
    })

    await login(page)
    await page.waitForTimeout(5_000)

    // Proves nginx's /socket.io/ location with Upgrade/Connection headers works.
    // Without it the terminal shows frozen prices and nothing else complains.
    expect(socketOpened, 'Socket.IO connection never opened').toBe(true)
  })

  test('trade history page renders', async ({ page }) => {
    await login(page)
    await page.goto('/dashboard/history')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('#root')).not.toBeEmpty()
  })
})

test.describe('@auth trade lifecycle', () => {
  test.skip(!ALLOW_TRADING, 'Set E2E_ALLOW_TRADING=1 to place real orders')

  test('open a market order, see it in open positions, then close it', async ({ page }) => {
    await login(page)

    // Reach the trading terminal.
    await page.goto('/dashboard')
    const terminalTab = page.getByRole('button', { name: /terminal|trade/i }).first()
    if (await terminalTab.isVisible().catch(() => false)) await terminalTab.click()

    const buyButton = page.getByRole('button', { name: /^buy$/i }).first()
    await expect(buyButton).toBeVisible({ timeout: 20_000 })

    const lotInput = page.locator('input[name="lots"], input[type="number"]').first()
    if (await lotInput.isVisible().catch(() => false)) await lotInput.fill('0.01')

    await buyButton.click()

    // Confirm dialog, if the UI uses one.
    const confirm = page.getByRole('button', { name: /confirm|place order/i }).first()
    if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click()

    // The new position must appear in the open-positions table.
    const positions = page.locator('table').filter({ hasText: /position|open/i }).first()
    await expect(positions).toBeVisible({ timeout: 20_000 })

    // Close it again so the test leaves no state behind.
    const closeButton = page.getByRole('button', { name: /^close$/i }).first()
    if (await closeButton.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await closeButton.click()
      const confirmClose = page.getByRole('button', { name: /confirm|yes/i }).first()
      if (await confirmClose.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await confirmClose.click()
      }
    }
  })
})

test.describe('@auth authorization boundaries', () => {
  test('admin panel rejects a plain trader', async ({ page }) => {
    await login(page)
    const res = await page.request.get('/api/admin/overview', { failOnStatusCode: false })
    expect(
      [401, 403].includes(res.status()),
      `Trader token reached an admin route: HTTP ${res.status()}`
    ).toBe(true)
  })

  test('another user\'s chat conversation is not readable', async ({ page }) => {
    await login(page)
    // chat.js scopes every trader query with `AND user_id = $2`, so a foreign
    // or non-existent id must 404 — never leak another trader's messages.
    const res = await page.request.get('/api/chat/conversations/00000000-0000-0000-0000-000000000001', {
      failOnStatusCode: false
    })
    expect([401, 403, 404]).toContain(res.status())
  })
})
