import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import AdminDataTable from './AdminDataTable'

/**
 * The admin tables carry 8-12 columns. On a phone that measured 1,298px wide
 * inside a 363px window -- it scrolls correctly, but reading one record takes
 * four sideways swipes. Card mode replaces the table below `md`.
 *
 * These tests pin the two things that makes concrete: the swap actually happens
 * at the breakpoint, and nothing a person needs is lost in the swap -- every
 * column still has a labelled value, and the row actions stay reachable without
 * going through a desktop dropdown.
 */

const COLUMNS = [
  { key: 'email', header: 'Email', primary: true },
  { key: 'account', header: 'Account', isMono: true },
  { key: 'balance', header: 'Balance' },
  { key: 'phase', header: 'Phase' },
  { key: 'internalRef', header: 'Internal Ref', hideOnMobile: true },
]

const DATA = [
  { id: 1, email: 'a.petrov@example.com', account: 'ACC-100482', balance: '$104,382.55', phase: 'Phase 2', internalRef: 'x-9912' },
  { id: 2, email: 'j.okafor@example.com', account: 'ACC-100931', balance: '$52,004.10', phase: 'Phase 1', internalRef: 'x-9913' },
]

/**
 * `useIsMobile()` reads `window.innerWidth` during render -- matchMedia is only
 * the subscription mechanism, and jsdom reports `matches: false` for every
 * query unless a test stubs it. Setting the width is therefore both sufficient
 * and closer to what the hook actually does in a browser.
 */
function setViewport(width) {
  window.innerWidth = width
}

afterEach(() => {
  setViewport(1024)
  vi.clearAllMocks()
})

describe('AdminDataTable', () => {
  it('renders a table on desktop', () => {
    setViewport(1280)
    const { container } = render(<AdminDataTable columns={COLUMNS} data={DATA} />)

    expect(container.querySelector('table.admin-table')).toBeTruthy()
    expect(container.querySelector('.admin-card')).toBeNull()
  })

  it('renders cards, not a table, below the md breakpoint', () => {
    setViewport(393)
    const { container } = render(<AdminDataTable columns={COLUMNS} data={DATA} />)

    // The table is GONE, not merely hidden. Dual-rendering 50 rows of 12
    // columns and hiding one copy in CSS is the cost this component exists to
    // avoid -- see the note in AdminDataTable.jsx.
    expect(container.querySelector('table.admin-table')).toBeNull()
    expect(container.querySelectorAll('.admin-card')).toHaveLength(2)
  })

  it('titles each card with the primary column and labels the rest', () => {
    setViewport(393)
    const { container } = render(<AdminDataTable columns={COLUMNS} data={DATA} />)

    const first = container.querySelectorAll('.admin-card')[0]
    expect(within(first).getByText('a.petrov@example.com')).toBeTruthy()

    // Every remaining column keeps its header as a visible label, so a value
    // is never stranded without saying what it is.
    for (const header of ['Account', 'Balance', 'Phase']) {
      expect(within(first).getByText(header)).toBeTruthy()
    }
    expect(within(first).getByText('ACC-100482')).toBeTruthy()
  })

  it('drops hideOnMobile columns from the card but keeps them on desktop', () => {
    setViewport(393)
    const { container, unmount } = render(<AdminDataTable columns={COLUMNS} data={DATA} />)
    expect(within(container).queryByText('Internal Ref')).toBeNull()
    expect(within(container).queryByText('x-9912')).toBeNull()
    unmount()

    setViewport(1280)
    const desktop = render(<AdminDataTable columns={COLUMNS} data={DATA} />)
    expect(desktop.getByText('Internal Ref')).toBeTruthy()
    expect(desktop.getByText('x-9912')).toBeTruthy()
  })

  it('falls back to the first column as the title when none is marked primary', () => {
    setViewport(393)
    const untagged = COLUMNS.map(({ primary, hideOnMobile, ...rest }) => rest)
    const { container } = render(<AdminDataTable columns={untagged} data={DATA} />)

    // This is what makes the change additive: the 28 pages already passing
    // `columns` get a sensible card without being edited.
    const title = container.querySelector('.admin-card__title')
    expect(title.textContent).toBe('a.petrov@example.com')
  })

  it('shows row actions as buttons rather than a dropdown', () => {
    setViewport(393)
    const onApprove = vi.fn()
    render(
      <AdminDataTable
        columns={COLUMNS}
        data={DATA}
        rowActions={[{ label: 'Approve', icon: 'check', onClick: onApprove }]}
      />
    )

    const buttons = screen.getAllByRole('button', { name: /approve/i })
    expect(buttons).toHaveLength(2)

    fireEvent.click(buttons[0])
    expect(onApprove).toHaveBeenCalledWith(DATA[0])
  })

  it('keeps selection working in card mode', () => {
    setViewport(393)
    const onToggleRow = vi.fn()
    render(
      <AdminDataTable
        columns={COLUMNS}
        data={DATA}
        selection={{ selectedIds: ['1'], onToggleRow }}
      />
    )

    const boxes = screen.getAllByRole('checkbox', { name: /select row/i })
    expect(boxes[0].checked).toBe(true)
    expect(boxes[1].checked).toBe(false)

    fireEvent.click(boxes[1])
    expect(onToggleRow).toHaveBeenCalledWith(DATA[1])
  })

  it('opens a record from the card title', () => {
    setViewport(393)
    const onRowClick = vi.fn()
    const { container } = render(
      <AdminDataTable columns={COLUMNS} data={DATA} onRowClick={onRowClick} />
    )

    fireEvent.click(container.querySelectorAll('.admin-card__title')[1])
    expect(onRowClick).toHaveBeenCalledWith(DATA[1])
  })

  it('can be opted out of card mode for matrix-shaped tables', () => {
    setViewport(393)
    const { container } = render(
      <AdminDataTable columns={COLUMNS} data={DATA} mobileCard={false} />
    )
    expect(container.querySelector('table.admin-table')).toBeTruthy()
  })

  it('still shows the empty state and pagination in card mode', () => {
    setViewport(393)
    const { rerender, container } = render(
      <AdminDataTable columns={COLUMNS} data={[]} emptyMessage="No traders found" />
    )
    expect(screen.getByText('No traders found')).toBeTruthy()

    rerender(
      <AdminDataTable
        columns={COLUMNS}
        data={DATA}
        pagination={{ current: 2, total: 5, total_items: 91 }}
        onPageChange={() => {}}
      />
    )
    expect(container.querySelector('.admin-pagination')).toBeTruthy()
    expect(screen.getByText(/Page 2 of 5/)).toBeTruthy()
  })
})
