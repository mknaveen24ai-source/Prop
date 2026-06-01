import React from 'react';
import AdminActionMenu from './AdminActionMenu';
import { renderIcon } from '../../utils/iconMap';

export default function AdminDataTable({
  columns,
  data,
  loading,
  emptyMessage = "No records found",
  emptyIcon = "file",
  pagination,
  onPageChange,
  rowActions,
  sort,
  onSortChange,
  selection,
  density = 'comfortable',
  onRowClick
}) {
  const selectedIds = Array.isArray(selection?.selectedIds) ? selection.selectedIds : [];
  const allSelected = !!selection?.allSelected;
  const someSelected = !!selection?.someSelected;

  const renderSortIndicator = (sortKey) => {
    if (!sort?.key || sort.key !== sortKey) return '↕';
    return sort.direction === 'asc' ? '↑' : '↓';
  };

  return (
    <div className={`admin-table-wrapper density-${density}`}>
      <table className="admin-table admin-table-sticky">
        <thead>
          <tr>
            {selection && (
              <th className="admin-th admin-th-checkbox admin-th-sticky">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(input) => {
                    if (input) input.indeterminate = !allSelected && someSelected;
                  }}
                  onChange={() => selection?.onToggleAll && selection.onToggleAll()}
                />
              </th>
            )}
            {columns.map((col, i) => (
              <th
                key={i}
                className={`admin-th ${i === 0 ? 'admin-th-sticky' : ''}`}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.sortKey && onSortChange ? (
                  <button
                    type="button"
                    className="admin-th-sort"
                    onClick={() => onSortChange(col.sortKey)}
                  >
                    <span>{col.header}</span>
                    <span className="admin-th-sort-indicator">{renderSortIndicator(col.sortKey)}</span>
                  </button>
                ) : col.header}
              </th>
            ))}
            {rowActions && <th className="admin-th" style={{ width: '50px' }}></th>}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={`skeleton-${i}`}>
                {selection && (
                  <td className="admin-td admin-td-checkbox admin-td-sticky">
                    <div className="admin-skeleton" style={{ height: '14px', width: '14px' }}></div>
                  </td>
                )}
                {columns.map((_, j) => (
                  <td key={j} className={`admin-td ${j === 0 ? 'admin-td-sticky' : ''}`}>
                    <div className="admin-skeleton" style={{ height: '16px', width: j === 0 ? '60%' : '100%' }}></div>
                  </td>
                ))}
                {rowActions && <td className="admin-td"></td>}
              </tr>
            ))
          ) : data && data.length > 0 ? (
            data.map((row, rowIndex) => (
              <tr
                key={row.id || rowIndex}
                className={selectedIds.includes(String(row.id)) ? 'admin-row-selected' : ''}
                onClick={() => onRowClick && onRowClick(row)}
              >
                {selection && (
                  <td className="admin-td admin-td-checkbox admin-td-sticky" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(String(row.id))}
                      onChange={() => selection?.onToggleRow && selection.onToggleRow(row)}
                    />
                  </td>
                )}
                {columns.map((col, colIndex) => (
                  <td key={colIndex} className={`admin-td ${col.isMono ? 'admin-td-mono' : ''} ${colIndex === 0 ? 'admin-td-sticky' : ''}`}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}

                {rowActions && (
                  <td className="admin-td" style={{ textAlign: 'right' }} onClick={(event) => event.stopPropagation()}>
                    <AdminActionMenu actions={typeof rowActions === 'function' ? rowActions(row) : rowActions} row={row} />
                  </td>
                )}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length + (rowActions ? 1 : 0) + (selection ? 1 : 0)}>
                <div className="admin-empty-state">
                  <div className="admin-empty-icon">
                    {renderIcon(emptyIcon, { size: 20, color: 'var(--admin-text-faint)' })}
                  </div>
                  <div className="admin-empty-title">{emptyMessage}</div>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {pagination && pagination.total > 1 && data && data.length > 0 && !loading && (
        <div className="admin-pagination">
          <div className="admin-page-info">
            Page {pagination.current} of {pagination.total}
            {pagination.total_items ? ` • ${pagination.total_items} items` : ''}
          </div>
          <div className="admin-page-controls">
            <button
              className="admin-page-btn"
              disabled={pagination.current <= 1}
              onClick={() => onPageChange(pagination.current - 1)}
            >
              Previous
            </button>
            <button
              className="admin-page-btn"
              disabled={pagination.current >= pagination.total}
              onClick={() => onPageChange(pagination.current + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
