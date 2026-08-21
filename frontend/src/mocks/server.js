import { setupServer } from 'msw/node'
import { handlers } from './handlers'

/**
 * MSW server for Vitest.
 *
 * Wired in src/setupTests.js with `onUnhandledRequest: 'error'` — a request no
 * handler covers fails the test rather than silently returning nothing. The
 * permissive default ('warn') means a component that starts calling a new
 * endpoint keeps passing while quietly receiving undefined, which is exactly the
 * failure mode a mock layer is supposed to close.
 */
export const server = setupServer(...handlers)
