import React from 'react'

/**
 * Ledger Desk table — heavy top rule under the header, thin row rules,
 * tabular-mono numeric columns. Generalizes the same convention already
 * used by AdminDataTable so trader-facing tables (open positions, trade
 * history) can share one visual language instead of hand-rolled <table>s.
 *
 * columns: [{ key, header, align: 'left'|'right', num: bool, render(row),
 *             primary: bool, hideOnMobile: bool }]
 * rows: array of row data objects (each needs a stable `id` or pass rowKey)
 * rowKey: (row) => key, defaults to row.id
 * mobileCard: below the `md` breakpoint, render each row as a stacked card
 *             instead of a table row. Opt-in, because it only suits tables
 *             whose rows are records rather than a matrix.
 *
 * Mobile handling, in short: a wide table inside `overflow-x: auto` still
 * squashes to illegibility because `.lx-table` is `width: 100%` with no floor.
 * So either the table keeps a readable minimum width and scrolls (default), or
 * it stops being a table (mobileCard).
 *
 * `primary` marks the column used as the card's title; `hideOnMobile` drops
 * low-value columns from the card. Both are ignored on desktop.
 */
export default function Table({
  columns,
  rows,
  rowKey,
  emptyMessage = 'No records found.',
  onRowClick,
  mobileCard = false,
  className = '',
}) {
  const getKey = rowKey || ((row, i) => row?.id ?? i)
  const cellValue = (col, row) => (col.render ? col.render(row) : row[col.key])

  const wrapClasses = [
    'lx-table-wrap',
    mobileCard ? 'lx-table-wrap--cards' : '',
    className,
  ].filter(Boolean).join(' ')

  const isEmpty = !rows || rows.length === 0

  return (
    <div className={wrapClasses}>
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
          {isEmpty ? (
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
                    {cellValue(col, row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>

      {mobileCard && (
        // Rendered alongside the table; CSS shows exactly one of the two. Kept
        // in the same component so callers declare their columns once.
        <div className="lx-cards" aria-hidden="false">
          {isEmpty ? (
            <p className="lx-table__empty">{emptyMessage}</p>
          ) : (
            rows.map((row, i) => {
              const primary = columns.find((c) => c.primary) || columns[0]
              const rest = columns.filter((c) => c !== primary && !c.hideOnMobile)
              const Wrapper = onRowClick ? 'button' : 'div'
              return (
                <Wrapper
                  key={getKey(row, i)}
                  className="lx-card-row"
                  type={onRowClick ? 'button' : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  <div className="lx-card-row__title">{cellValue(primary, row)}</div>
                  <dl className="lx-card-row__fields">
                    {rest.map((col) => (
                      <div key={col.key}>
                        <dt>{col.header}</dt>
                        <dd className={col.num || col.align === 'right' ? 'lx-num' : undefined}>
                          {cellValue(col, row)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </Wrapper>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
