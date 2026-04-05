// This test file was previously using the stale CRA template test
// ('learn react' text) which never existed in this app and always failed.
// Replaced with a basic smoke test that just verifies the app renders
// without crashing — the most useful baseline test for a React app.

import { render, waitFor } from '@testing-library/react'
import App from './App'

// Mock react-router-dom for test environments where package resolution can fail
// under Jest + react-scripts. We only need a shallow router shell for smoke tests.
jest.mock('react-router-dom', () => {
  const React = require('react')
  return {
    BrowserRouter: ({ children }) => React.createElement(React.Fragment, null, children),
    Routes: ({ children }) => React.createElement(React.Fragment, null, children),
    Route: ({ element }) => element || null,
    Navigate: () => null
  }
}, { virtual: true })

jest.mock('lightweight-charts', () => ({
  createChart: jest.fn(() => ({
    addSeries: jest.fn(() => ({
      setData: jest.fn(),
      update: jest.fn()
    })),
    timeScale: jest.fn(() => ({
      fitContent: jest.fn(),
      applyOptions: jest.fn()
    })),
    applyOptions: jest.fn(),
    remove: jest.fn()
  })),
  CandlestickSeries: {}
}), { virtual: true })

// Mock axios to avoid real network calls during tests
jest.mock('axios', () => {
  const apiClient = {
    get: jest.fn(() => Promise.reject(new Error('network'))),
    post: jest.fn(() => Promise.reject(new Error('network'))),
    patch: jest.fn(() => Promise.reject(new Error('network'))),
    delete: jest.fn(() => Promise.reject(new Error('network'))),
    put: jest.fn(() => Promise.reject(new Error('network'))),
    defaults: { withCredentials: false },
    interceptors: {
      request: { use: jest.fn(() => 0), eject: jest.fn() },
      response: { use: jest.fn(() => 0), eject: jest.fn() }
    }
  }

  return {
    get: jest.fn(() => Promise.reject(new Error('network'))),
    post: jest.fn(() => Promise.reject(new Error('network'))),
    patch: jest.fn(() => Promise.reject(new Error('network'))),
    delete: jest.fn(() => Promise.reject(new Error('network'))),
    put: jest.fn(() => Promise.reject(new Error('network'))),
    create: jest.fn(() => apiClient),
    defaults: { withCredentials: false },
    interceptors: {
      request: { use: jest.fn(() => 0), eject: jest.fn() },
      response: { use: jest.fn(() => 0), eject: jest.fn() }
    }
  }
})

// Mock socket.io-client to avoid WebSocket errors in jsdom
jest.mock('socket.io-client', () => {
  const mockSocket = {
    on: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  }
  return jest.fn(() => mockSocket)
})

test('app renders without crashing', async () => {
  // If this throws, there is a fundamental render error in App or one of its
  // top-level providers (ThemeProvider, Router, etc.)
  const { container } = render(<App />)
  await waitFor(() => {
    expect(container).toBeTruthy()
  })
})
