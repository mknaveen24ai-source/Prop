import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { renderIcon } from '../../utils/iconMap';

const ToastContext = createContext(null);

export function AdminToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idCounter = useRef(0);

  const addToast = useCallback((title, message, type = 'success') => {
    const id = ++idCounter.current;
    setToasts(prev => [...prev, { id, title, message, type }]);

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

  const iconMap = {
    success: renderIcon('approve', { size: 18, color: 'var(--accent-green)' }),
    error: renderIcon('reject', { size: 18, color: 'var(--accent-red)' }),
    warning: renderIcon('warning', { size: 18, color: 'var(--accent-gold)' }),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="admin-toast-container">
        {toasts.map(toast => (
          <div key={toast.id} className={`admin-toast ${toast.type}`}>
            <div className="admin-toast-icon">
              {iconMap[toast.type]}
            </div>
            <div className="admin-toast-content">
              <div className="admin-toast-title">{toast.title}</div>
              {toast.message && <div className="admin-toast-message">{toast.message}</div>}
            </div>
            <button className="admin-toast-close" onClick={() => removeToast(toast.id)}>
              {renderIcon('close', { size: 14, color: 'var(--admin-text-faint)' })}
            </button>
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
