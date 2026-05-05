import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import ErrorBoundary from './ErrorBoundary';
import { ApiStateProvider } from './providers/ApiStateProvider';
import { TenantConfigProvider } from './providers/TenantConfigProvider';
import { AuthProvider } from './providers/AuthProvider';
import { AdminSessionProvider } from './providers/AdminSessionProvider';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <ApiStateProvider>
        <TenantConfigProvider>
          <AuthProvider>
            <AdminSessionProvider>
              <App />
            </AdminSessionProvider>
          </AuthProvider>
        </TenantConfigProvider>
      </ApiStateProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
