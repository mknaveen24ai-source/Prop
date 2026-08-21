import React from 'react';
import AdminActionMenu from './AdminActionMenu';
import { renderIcon } from '../../utils/iconMap';
import { useIsMobile } from '../../hooks/useBreakpoint';
import { rowInteractionProps } from '../../utils/interactive';

/**
 * The admin record table.
 *
 * ── Card mode ──
 *
 * Below the `md` breakpoint each row becomes a stacked card. The admin tables
 * carry 8-12 columns, and while they do scroll correctly on a phone -- the
 * `white-space: nowrap` on `.admin-td` keeps min-content above the wrapper
 * width, so nothing squashes -- a measured 1,298px table inside a 363px window
 * is three and a half screens of sideways scrolling per row. Scrolling is not
 * the defect; reading one record across four swipes is.
 *
 * The column vocabulary is deliberately the same one `ui/Table.jsx` already
 * established for trader-facing tables:
 *
 *   primary       the column used as the card's title. Defaults to columns[0].
 *   hideOnMobile  drop this column from the card. Ignored on desktop.
 *
 * Both are optional, so the 28 pages already passing `columns` get a sensible
 * card without being touched.
 *
 * ── Why this gates on a hook and Table.jsx does not ──
 *
 * `ui/Table.jsx` renders both representations and lets CSS display one. That is
 * the right trade for a ten-row trader table and the wrong one here: an admin
 * page shows 50 rows of 12 columns, so dual-rendering would build 600 cells per
 * paint that nobody can see. `useIsMobile()` is `useSyncExternalStore`-backed,
 * so it reads during render with no first-paint flash, and its threshold is the
 * same 768px the stylesheets use -- see src/styles/breakpoints.js.
 */
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
  onRowClick,
  mobileCard = true
}) {
  const selectedIds = Array.isArray(selection?.selectedIds) ? selection.selectedIds : [];
  const allSelected = !!selection?.allSelected;
  const someSelected = !!selection?.someSelected;
  const isMobile = useIsMobile();
  const asCards = mobileCard && isMobile;

  const renderSortIndicator = (sortKey) => {
    if (!sort?.key || sort.key !== sortKey) return '↕';
    return sort.direction === 'asc' ? '↑' : '↓';
  };

  // aria-sort is a property of the column header, not of the button inside it.
  // Without it the arrow glyph is the only indication of sort state, and a
  // glyph is not exposed as state to a screen reader.
  const ariaSortFor = (sortKey) => {
    if (!sortKey || !onSortChange) return undefined;
    if (sort?.key !== sortKey) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  };

  const isSelected = (row) => selectedIds.includes(String(row.id));

  const paginationBar = pagination && pagination.total > 1 && data && data.length > 0 && !loading && (
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
  );

  const emptyState = (
    <div className="admin-empty-state">
      <div className="admin-empty-icon">
        {renderIcon(emptyIcon, { size: 20, color: 'var(--admin-text-faint)' })}
      </div>
      <div className="admin-empty-title">{emptyMessage}</div>
    </div>
  );

  if (asCards) {
    const primary = columns.find((c) => c.primary) || columns[0];
    const fields = columns.filter((c) => c !== primary && !c.hideOnMobile);
    const cellOf = (col, row) => (col.render ? col.render(row) : row[col.key]);

    return (
      <div className={`admin-cards-wrap density-${density}`}>
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div className="admin-card" key={`skeleton-${i}`}>
              <div className="admin-skeleton admin-card__skeleton-title"></div>
              <div className="admin-skeleton admin-card__skeleton-line"></div>
              <div className="admin-skeleton admin-card__skeleton-line"></div>
            </div>
          ))
        ) : data && data.length > 0 ? (
          data.map((row, rowIndex) => (
            <div
              key={row.id || rowIndex}
              className={`admin-card ${isSelected(row) ? 'admin-card--selected' : ''}`}
            >
              <div className="admin-card__head">
                {selection && (
                  <input
                    type="checkbox"
                    className="admin-card__select"
                    checked={isSelected(row)}
                    onChange={() => selection?.onToggleRow && selection.onToggleRow(row)}
                    aria-label="Select row"
                  />
                )}
                {/* The title is the row's identity, so it is what opens the
                    record. A whole-card click target would swallow the taps on
                    the checkbox and the action buttons underneath it. */}
                {onRowClick ? (
                  <button type="button" className="admin-card__title" onClick={() => onRowClick(row)}>
                    {cellOf(primary, row)}
                  </button>
                ) : (
                  <div className="admin-card__title">{cellOf(primary, row)}</div>
                )}
              </div>

              <dl className="admin-card__fields">
                {fields.map((col, i) => (
                  <div key={col.key || i}>
                    <dt>{typeof col.header === 'string' ? col.header : ''}</dt>
                    <dd className={col.isMono ? 'admin-td-mono' : undefined}>{cellOf(col, row)}</dd>
                  </div>
                ))}
              </dl>

              {rowActions && <CardActions rowActions={rowActions} row={row} />}
            </div>
          ))
        ) : emptyState}

        {paginationBar}
      </div>
    );
  }

  return (
    <div className={`admin-table-wrapper density-${density}`}>
      <table className="admin-table">
        <thead>
          <tr>
            {selection && (
              <th className="admin-th admin-th-checkbox admin-th-sticky">
                <input
                  type="checkbox"
                  aria-label={allSelected ? 'Deselect all rows' : 'Select all rows'}
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
                scope="col"
                aria-sort={ariaSortFor(col.sortKey)}
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
            {rowActions && <th className="admin-th admin-th-actions"></th>}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={`skeleton-${i}`}>
                {selection && (
                  <td className="admin-td admin-td-checkbox admin-td-sticky">
                    <div className="admin-skeleton admin-skeleton--box"></div>
                  </td>
                )}
                {columns.map((_, j) => (
                  <td key={j} className={`admin-td ${j === 0 ? 'admin-td-sticky' : ''}`}>
                    <div className={`admin-skeleton ${j === 0 ? 'admin-skeleton--short' : 'admin-skeleton--full'}`}></div>
                  </td>
                ))}
                {rowActions && <td className="admin-td"></td>}
              </tr>
            ))
          ) : data && data.length > 0 ? (
            data.map((row, rowIndex) => (
              <tr
                key={row.id || rowIndex}
                className={isSelected(row) ? 'admin-row-selected' : ''}
                {...(onRowClick
                  ? rowInteractionProps(() => onRowClick(row))
                  : {})}
              >
                {selection && (
                  <td className="admin-td admin-td-checkbox admin-td-sticky" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select row ${rowIndex + 1}`}
                      checked={isSelected(row)}
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
                  <td className="admin-td admin-td-actions" onClick={(event) => event.stopPropagation()}>
                    <AdminActionMenu actions={typeof rowActions === 'function' ? rowActions(row) : rowActions} row={row} />
                  </td>
                )}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length + (rowActions ? 1 : 0) + (selection ? 1 : 0)}>
                {emptyState}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {paginationBar}
    </div>
  );
}

/**
 * Row actions as a button row rather than the desktop kebab.
 *
 * A dropdown behind a 16px icon is a mouse affordance: on a phone it costs a
 * tap to discover and puts the menu somewhere the thumb is not. There is room
 * in a card for the actions themselves, so they are shown.
 *
 * Actions passed as React elements are rendered as-is -- several admin pages
 * pass a ready-made control rather than a descriptor, and the desktop menu
 * already supports both.
 */
function CardActions({ rowActions, row }) {
  const actions = typeof rowActions === 'function' ? rowActions(row) : rowActions;
  if (!actions || actions.length === 0) return null;

  return (
    <div className="admin-card__actions">
      {actions.map((action, i) => React.isValidElement(action) ? (
        <div key={i} className="admin-card__action-slot">{action}</div>
      ) : (
        <button
          key={i}
          type="button"
          className={`admin-card__action ${action.danger ? 'danger' : ''}`}
          onClick={() => action.onClick(row)}
        >
          {action.icon && renderIcon(action.icon, {
            size: 14,
            color: action.danger ? 'var(--admin-danger)' : 'var(--admin-text-faint)'
          })}
          {action.label}
        </button>
      ))}
    </div>
  );
}
