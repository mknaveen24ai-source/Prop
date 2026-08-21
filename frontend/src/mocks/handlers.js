import { http, HttpResponse } from 'msw'

/**
 * Default MSW handlers.
 *
 * ── What these are for ───────────────────────────────────────────────────────
 *
 * Every existing test either renders a leaf component with props or exercises a
 * pure helper. Nothing covered a flow that talks to the API, which is where the
 * money-adjacent bugs in this codebase have actually lived: a payload field
 * renamed, a 402 rendered as a success, a validation error swallowed.
 *
 * These are the *happy path*. A test that needs a failure overrides the one
 * route it cares about with `server.use(...)`, so the failure it is testing is
 * visible in the test rather than buried here.
 *
 * ── Why the money values are strings ─────────────────────────────────────────
 *
 * They are strings on the wire (see src/types.js). Mocking them as numbers would
 * make a test pass against a fixture the server never sends, which is worse than
 * no test — it would specifically hide the class of bug the Decimal layer exists
 * to prevent.
 */

export const mockAccount = {
  id: 'acc-1',
  account_uid: 'PF-100001',
  user_id: 'user-1',
  starting_balance: '10000.00',
  current_balance: '10432.75',
  profit_target: '11000.00',
  status: 'active',
  max_drawdown_pct: 10,
  daily_drawdown_limit_pct: 5,
}

export const mockUser = {
  id: 'user-1',
  email: 'trader@example.com',
  full_name: 'Test Trader',
  kyc_status: 'not_submitted',
}

/** Base URL is empty in tests (same-origin), so paths are matched bare. */
export const handlers = [
  http.get('*/api/auth/me', () => HttpResponse.json(mockUser)),

  http.get('*/api/accounts', () => HttpResponse.json([mockAccount])),

  http.get('*/api/accounts/:id/stats', () =>
    HttpResponse.json({
      account: mockAccount,
      rules: { profit_target_amount: 1000, max_drawdown_pct: 10 },
      stats: { consistency: 82 },
    })
  ),

  http.get('*/api/kyc/status', () =>
    HttpResponse.json({ status: 'not_submitted', documents: [] })
  ),

  http.post('*/api/kyc/upload', () =>
    HttpResponse.json({ success: true, status: 'pending' })
  ),

  http.get('*/api/payouts', () => HttpResponse.json([])),

  http.post('*/api/payouts/request', () =>
    HttpResponse.json({ success: true, id: 'payout-1', status: 'pending' })
  ),

  http.get('*/api/accounts/step-models', () =>
    HttpResponse.json({
      models: [
        { slug: 'two-step', name: 'Two Step', sizes: [10000, 25000, 50000] },
      ],
    })
  ),

  http.post('*/api/checkout/create', () =>
    HttpResponse.json({ success: true, order_id: 'order-1' })
  ),

  http.get('*/api/announcement', () => HttpResponse.json(null)),

  http.get('*/api/transparency/*', () => HttpResponse.json({ data: [] })),
]
