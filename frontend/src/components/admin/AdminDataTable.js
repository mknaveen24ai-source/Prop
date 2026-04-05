import React from 'react';
import AdminActionMenu from './AdminActionMenu';

export default function AdminDataTable({
  columns,      // [{ header: 'Name', key: 'name', render: (row) => JSX, isMono: boolean }]
  data,         // array of objects
  loading,
  emptyMessage = "No records found",
  emptyIcon = "📄",
  pagination,   // { current: 1, total: 10 }
  onPageChange, // fn(pageNum)
  rowActions    // array of actions for AdminActionMenu or function(row) returning actions
}) {
  return (
    <div className="admin-table-wrapper">
      <table className="admin-table">
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th key={i} className="admin-th">{col.header}</th>
            ))}
            {rowActions && <th className="admin-th" style={{ width: '50px' }}></th>}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={`skeleton-${i}`}>
                {columns.map((_, j) => (
                  <td key={j} className="admin-td">
                    <div className="admin-skeleton" style={{ height: '16px', width: j === 0 ? '60%' : '100%' }}></div>
                  </td>
                ))}
                {rowActions && <td className="admin-td"></td>}
              </tr>
            ))
          ) : data && data.length > 0 ? (
            data.map((row, rowIndex) => (
              <tr key={row.id || rowIndex}>
                {columns.map((col, colIndex) => (
                  <td key={colIndex} className={`admin-td ${col.isMono ? 'admin-td-mono' : ''}`}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
                
                {rowActions && (
                  <td className="admin-td" style={{ textAlign: 'right' }}>
                    <AdminActionMenu actions={typeof rowActions === 'function' ? rowActions(row) : rowActions} row={row} />
                  </td>
                )}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length + (rowActions ? 1 : 0)}>
                <div className="admin-empty-state">
                  <div className="admin-empty-icon">{emptyIcon}</div>
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
