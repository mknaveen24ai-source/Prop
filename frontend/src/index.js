import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import ErrorBoundary from './ErrorBoundary';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    {/*
      FIX Bug: Wrap the entire app in an ErrorBoundary so that any unhandled
      React render error shows a graceful recovery screen instead of a
      blank white page with no message and no way to recover.

      The ErrorBoundary catches errors in:
        - Component render methods
        - Lifecycle methods (useEffect, componentDidMount, etc.)
        - Constructors of child components

      It does NOT catch errors in:
        - Event handlers (use try/catch inside those)
        - Async code like setTimeout or fetch (use try/catch)
        - The error boundary component itself
    */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();