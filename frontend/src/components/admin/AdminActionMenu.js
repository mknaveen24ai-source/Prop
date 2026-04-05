import React, { useState, useRef, useEffect } from 'react';

export default function AdminActionMenu({ actions, row }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef();

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (!actions || actions.length === 0) return null;

  return (
    <div className="admin-action-menu-wrap" ref={menuRef}>
      <button 
        className="admin-action-btn"
        onClick={(e) => { e.stopPropagation(); setOpen(p => !p); }}
      >
        •••
      </button>

      {open && (
        <div className="admin-dropdown">
          {actions.map((action, i) => React.isValidElement(action) ? (
            <div key={i} onClick={() => setOpen(false)}>{action}</div>
          ) : (
            <button
              key={i}
              className={`admin-dropdown-item ${action.danger ? 'danger' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                action.onClick(row);
              }}
            >
              <span style={{ width: '16px', textAlign: 'center' }}>{action.icon}</span>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
