import React, { useEffect } from 'react';

export default function AdminModal({ 
  isOpen, 
  onClose, 
  title, 
  size = 'md', // sm, md, lg, xl, fullscreen
  footer, 
  children 
}) {
  // Prevent body scroll when modal is open
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
        onMouseDown={e => e.stopPropagation()} // Prevent click-through closing
      >
        <div className="admin-modal-header">
          <h3 className="admin-modal-title">{title}</h3>
          <button className="admin-modal-close" onClick={onClose}>✕</button>
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
