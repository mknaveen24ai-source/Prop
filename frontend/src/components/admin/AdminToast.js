import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

const ToastContext = createContext(null);

export function AdminToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idCounter = useRef(0);

  const addToast = useCallback((title, message, type = 'success') => {
    const id = ++idCounter.current;
    setToasts(prev => [...prev, { id, title, message, type }]);

    // Auto dismiss after 4s
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const value = {
    success: (msg, title) => addToast(title || 'Success', msg, 'success'),
    error: (msg, title) => addToast(title || 'Error', msg, 'error'),
    warning: (msg, title) => addToast(title || 'Warning', msg, 'warning'),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="admin-toast-container">
        {toasts.map(toast => (
          <div key={toast.id} className={`admin-toast ${toast.type}`}>
            <div className="admin-toast-icon">
              {toast.type === 'success' && '✓'}
              {toast.type === 'error' && '✕'}
              {toast.type === 'warning' && '⚠'}
            </div>
            <div className="admin-toast-content">
              <div className="admin-toast-title">{toast.title}</div>
              {toast.message && <div className="admin-toast-message">{toast.message}</div>}
            </div>
            <button className="admin-toast-close" onClick={() => removeToast(toast.id)}>✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within an AdminToastProvider');
  }
  return context;
}
