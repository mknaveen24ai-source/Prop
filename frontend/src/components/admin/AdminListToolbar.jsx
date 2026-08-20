import React, { useMemo, useState } from 'react';

export default function AdminListToolbar({
  resourceLabel = 'records',
  views = [],
  activeViewId = '',
  onSelectView,
  onSaveView,
  onUpdateView,
  onDeleteView,
  density = 'comfortable',
  onDensityChange,
  columns = [],
  visibleColumnKeys = [],
  onToggleColumn,
  onExport,
  extraActions,
  selectionLabel
}) {
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const activeView = useMemo(
    () => views.find((view) => String(view.id) === String(activeViewId)) || null,
    [views, activeViewId]
  );

  return (
    <div className="admin-list-toolbar">
      <div className="admin-list-toolbar-group">
        <select
          className="admin-select"
          value={activeViewId || ''}
          onChange={(event) => onSelectView && onSelectView(event.target.value)}
        >
          <option value="">Default view</option>
          {views.map((view) => (
            <option key={view.id} value={view.id}>
              {view.name}{view.is_default ? ' • default' : ''}
            </option>
          ))}
        </select>

        <button className="admin-btn admin-btn-ghost" onClick={() => onSaveView && onSaveView()}>
          Save View
        </button>
        <button
          className="admin-btn admin-btn-ghost"
          onClick={() => activeView && onUpdateView && onUpdateView(activeView)}
          disabled={!activeView}
        >
          Update View
        </button>
        <button
          className="admin-btn admin-btn-ghost"
          onClick={() => activeView && onDeleteView && onDeleteView(activeView)}
          disabled={!activeView}
        >
          Delete View
        </button>
      </div>

      <div className="admin-list-toolbar-group">
        {selectionLabel && <span className="admin-selection-pill">{selectionLabel}</span>}
        {extraActions}
        <button className="admin-btn admin-btn-ghost" onClick={() => onExport && onExport()}>
          Export {resourceLabel}
        </button>

        <div className="admin-inline-segment">
          <button
            className={`admin-segment-btn ${density === 'comfortable' ? 'active' : ''}`}
            onClick={() => onDensityChange && onDensityChange('comfortable')}
          >
            Comfortable
          </button>
          <button
            className={`admin-segment-btn ${density === 'compact' ? 'active' : ''}`}
            onClick={() => onDensityChange && onDensityChange('compact')}
          >
            Compact
          </button>
        </div>

        <div className="admin-action-menu-wrap">
          <button className="admin-btn admin-btn-ghost" onClick={() => setColumnMenuOpen((open) => !open)}>
            Columns
          </button>
          {columnMenuOpen && (
            <div className="admin-dropdown" style={{ minWidth: '220px' }}>
              {columns.map((column) => (
                <label key={column.key || column.sortKey || column.header} className="admin-dropdown-item" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={visibleColumnKeys.includes(column.key)}
                    onChange={() => onToggleColumn && onToggleColumn(column.key)}
                    style={{ marginRight: 'var(--space-2)' }}
                  />
                  {column.header}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
