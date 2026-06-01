import React, { useEffect } from 'react';
import { renderIcon } from '../../utils/iconMap';

export default function AdminModal({
  isOpen,
  onClose,
  title,
  size = 'md',
  footer,
  children
}) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'auto';
    }
    return () => {
      document.body.style.overflow = 'auto';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="admin-modal-overlay" onMouseDown={onClose}>
      <div
        className={`admin-modal ${size}`}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="admin-modal-header">
          <h3 className="admin-modal-title">{title}</h3>
          <button className="admin-modal-close" onClick={onClose}>
            {renderIcon('close', { size: 16, color: 'var(--admin-text-faint)' })}
          </button>
        </div>

        <div className="admin-modal-body">
          {children}
        </div>

        {footer && (
          <div className="admin-modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
