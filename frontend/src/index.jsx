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

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
