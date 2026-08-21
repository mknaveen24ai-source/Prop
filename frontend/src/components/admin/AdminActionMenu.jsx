import React, { useEffect, useRef, useState } from 'react';
import { renderIcon } from '../../utils/iconMap';

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
        {renderIcon('menu', { size: 16, color: 'var(--admin-text-faint)' })}
      </button>

      {open && (
        <div className="admin-dropdown">
          {actions.map((action, i) => React.isValidElement(action) ? (
            // Not interactive itself -- it wraps a caller-supplied element and
            // closes the menu once that element is used. The listener stays on
            // the wrapper (the child's own handler is the caller's), but it is
            // presentational, so it takes no role and no tab stop.
            <div key={i} role="presentation" onClick={() => setOpen(false)}>{action}</div>
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
              <span style={{ width: '16px', textAlign: 'center', display: 'inline-flex', justifyContent: 'center' }}>
                {renderIcon(action.icon, {
                  size: 14,
                  color: action.danger ? 'var(--admin-danger)' : 'var(--admin-text-faint)'
                })}
              </span>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
