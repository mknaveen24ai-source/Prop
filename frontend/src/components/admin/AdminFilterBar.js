import React from 'react';
import { renderIcon } from '../../utils/iconMap';

export default function AdminFilterBar({ searchPlaceholder = "Search...", searchValue, onSearchChange, children }) {
  return (
    <div className="admin-filter-bar">
      <div style={{ position: 'relative', width: '300px', maxWidth: '100%' }}>
        <span className="admin-search-icon">
          {renderIcon('search', { size: 14, color: 'var(--admin-text-faint)' })}
        </span>
        <input
          type="text"
          className="admin-search-input"
          placeholder={searchPlaceholder}
          value={searchValue || ''}
          onChange={e => onSearchChange && onSearchChange(e.target.value)}
        />
      </div>

      {children && (
        <div className="admin-filter-group">
          {children}
        </div>
      )}
    </div>
  );
}
