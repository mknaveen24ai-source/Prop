// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

import { beforeAll, afterEach, afterAll } from 'vitest';
import { server } from './mocks/server';

// ── Mock Service Worker ──────────────────────────────────────────────────────
//
// Intercepts at the network layer rather than by mocking axios, so the code
// under test runs its real request path: interceptors, the X-Request-ID header,
// the device signature, error normalisation. Mocking the axios module skips all
// of that, which is where several of this project's shipped defects lived.
//
// onUnhandledRequest: 'error' is deliberate. The default warns and lets the
// request through, so a component that starts calling a new endpoint keeps
// passing while receiving undefined — a green suite that has stopped checking
// anything. An unmocked call should be a loud failure with the URL in it.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

// Per-test overrides via server.use() are undone here, so one test's simulated
// 500 cannot leak into the next.
afterEach(() => server.resetHandlers());

afterAll(() => server.close());
