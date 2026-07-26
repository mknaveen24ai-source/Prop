import React from 'react'

/**
 * Ledger Desk table — heavy top rule under the header, thin row rules,
 * tabular-mono numeric columns. Generalizes the same convention already
 * used by AdminDataTable so trader-facing tables (open positions, trade
 * history) can share one visual language instead of hand-rolled <table>s.
 *
 * columns: [{ key, header, align: 'left'|'right', num: bool, render(row) }]
 * rows: array of row data objects (each needs a stable `id` or pass rowKey)
 * rowKey: (row) => key, defaults to row.id
 */
export default function Table({ columns, rows, rowKey, emptyMessage = 'No records found.', onRowClick, className = '' }) {
  const getKey = rowKey || ((row, i) => row?.id ?? i)

  return (
    <div className={['lx-table-wrap', className].filter(Boolean).join(' ')}>
      <table className="lx-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} className={col.num || col.align === 'right' ? 'lx-num' : undefined}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(!rows || rows.length === 0) ? (
            <tr>
              <td className="lx-table__empty" colSpan={columns.length}>{emptyMessage}</td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={getKey(row, i)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key} className={col.num || col.align === 'right' ? 'lx-num' : undefined}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
