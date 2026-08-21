import React from 'react';
import ReactDOM from 'react-dom/client';
// Sentry must initialize before anything else renders, so that errors thrown
// during the first paint are captured too. No-op when VITE_SENTRY_DSN is unset.
import { initSentry } from './utils/sentry';
import './index.css';
import App from './App';
import ErrorBoundary from './ErrorBoundary';
import { ApiStateProvider } from './providers/ApiStateProvider';
import { BrandingProvider } from './BrandingContext';
import { AuthProvider } from './providers/AuthProvider';
import { AdminSessionProvider } from './providers/AdminSessionProvider';
import reportWebVitals from './reportWebVitals';
import { registerServiceWorker } from './utils/registerServiceWorker';

initSentry();

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <ApiStateProvider>
        <BrandingProvider>
          <AuthProvider>
            <AdminSessionProvider>
              <App />
            </AdminSessionProvider>
          </AuthProvider>
        </BrandingProvider>
      </ApiStateProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// Offline shell only -- the worker never caches an API response. See
// sw-template.js. Registered after render so it cannot delay first paint, and
// it announces an available update through a window event rather than a
// callback, so ConnectionStatusBar can be mounted anywhere in the tree.
registerServiceWorker((registration) => {
  window.dispatchEvent(new CustomEvent('propfirm:sw-update', { detail: registration }));
});

// Core Web Vitals -> Sentry. Called with no argument on purpose: the reporter
// sends to Sentry regardless, and only takes a callback for local debugging
// (`reportWebVitals(console.log)`). The CRA scaffold this replaced required the
// argument to do anything at all, so this exact call measured nothing.
reportWebVitals();
