import React from 'react'
import AdminDataTable from './admin/AdminDataTable'
import Table from './ui/Table'
import Card from './ui/Card'
import Button from './ui/Button'

/**
 * The surfaces the viewport matrix measures.
 *
 * `e2e/tests/responsive.spec.js` loads these at 280, 320, 393, 768 and 852px
 * and asserts two things per viewport: the document never scrolls sideways, and
 * every focusable control clears the platform minimum tap target.
 *
 * ── Why these live in Storybook rather than being asserted against the app ──
 *
 * The same reason the visual project does it: a story renders fixed content and
 * hits no backend, so the measurement depends on the CSS and nothing else.
 * Pointing the matrix at /dashboard would make every assertion depend on how
 * many positions the seed account happens to hold, and a suite that fails for
 * reasons unrelated to layout gets muted.
 *
 * The tables here carry deliberately hostile data -- twelve columns, long
 * unbroken account identifiers, negative currency values -- because that is
 * what actually overflows. A table of short tidy strings passes at 280px while
 * telling you nothing.
 */

export default {
  title: 'Responsive/Surfaces',
  parameters: {
    layout: 'fullscreen'
  }
}

const COLUMNS = [
  { key: 'email', header: 'Email', primary: true },
  { key: 'account', header: 'Account', isMono: true },
  { key: 'balance', header: 'Balance' },
  { key: 'equity', header: 'Equity' },
  { key: 'floating', header: 'Floating P&L' },
  { key: 'drawdown', header: 'Drawdown' },
  { key: 'phase', header: 'Phase' },
  { key: 'status', header: 'Status' },
  { key: 'created', header: 'Created' },
  { key: 'lastTrade', header: 'Last Trade' },
  { key: 'country', header: 'Country' },
  { key: 'internalRef', header: 'Internal Ref', hideOnMobile: true },
]

const ROWS = [
  {
    id: 1, email: 'alexandra.petrov@example-domain.com', account: 'ACC-100482-EU-PHASE2',
    balance: '$104,382.55', equity: '$103,911.20', floating: '-$471.35', drawdown: '4.21%',
    phase: 'Phase 2', status: 'Active', created: '2026-03-14', lastTrade: '2026-08-19 14:22',
    country: 'Bulgaria', internalRef: 'x-9912',
  },
  {
    id: 2, email: 'j.okafor@example-domain.com', account: 'ACC-100931-NG-PHASE1',
    balance: '$52,004.10', equity: '$52,884.65', floating: '+$880.55', drawdown: '1.04%',
    phase: 'Phase 1', status: 'Active', created: '2026-06-02', lastTrade: '2026-08-20 09:08',
    country: 'Nigeria', internalRef: 'x-9913',
  },
  {
    id: 3, email: 'takahiro.yamamoto@example-domain.com', account: 'ACC-101772-JP-FUNDED',
    balance: '$210,550.00', equity: '$209,118.40', floating: '-$1,431.60', drawdown: '7.88%',
    phase: 'Funded', status: 'Breached', created: '2025-11-27', lastTrade: '2026-08-18 23:51',
    country: 'Japan', internalRef: 'x-9914',
  },
]

const ACTIONS = [
  { label: 'Approve', icon: 'check', onClick: () => {} },
  { label: 'View', icon: 'eye', onClick: () => {} },
  { label: 'Ban', icon: 'x', onClick: () => {}, danger: true },
]

/**
 * Twelve columns of operator data. Above `md` this is a table in a scroller;
 * below it, one card per record. The swap is the component's, not the
 * stylesheet's -- see AdminDataTable.jsx.
 */
export const AdminTable = () => (
  <div style={{ padding: 'var(--space-4)' }}>
    <AdminDataTable
      columns={COLUMNS}
      data={ROWS}
      rowActions={ACTIONS}
      pagination={{ current: 2, total: 7, total_items: 168 }}
      onPageChange={() => {}}
      onRowClick={() => {}}
    />
  </div>
)

/** Selection checkboxes have to stay reachable in card mode too. */
export const AdminTableSelectable = () => (
  <div style={{ padding: 'var(--space-4)' }}>
    <AdminDataTable
      columns={COLUMNS}
      data={ROWS}
      selection={{ selectedIds: ['2'], onToggleRow: () => {}, onToggleAll: () => {} }}
      rowActions={ACTIONS}
    />
  </div>
)

/** The matrix-shaped opt-out: still a table on a phone, inside a scroller. */
export const AdminTableOptedOut = () => (
  <div style={{ padding: 'var(--space-4)' }}>
    <AdminDataTable columns={COLUMNS} data={ROWS} mobileCard={false} />
  </div>
)

/** The trader-facing equivalent, via ui/Table's own card mode. */
export const TraderTableCards = () => (
  <div style={{ padding: 'var(--space-4)' }}>
    <Card ruled flush title="Payout history">
      <Table
        mobileCard
        columns={[
          { key: 'ref', header: 'Reference', primary: true },
          { key: 'amount', header: 'Amount', num: true },
          { key: 'method', header: 'Method' },
          { key: 'requested', header: 'Requested' },
          { key: 'status', header: 'Status' },
        ]}
        rows={[
          { id: 1, ref: 'PO-2026-000418', amount: '$8,420.00', method: 'Bank transfer', requested: '2026-08-02', status: 'Paid' },
          { id: 2, ref: 'PO-2026-000502', amount: '$12,905.55', method: 'Crypto (USDT)', requested: '2026-08-17', status: 'Pending' },
        ]}
      />
    </Card>
  </div>
)

/** A wide unwrapped table is the classic page-overflow source; this one scrolls. */
export const TraderTableScrolling = () => (
  <div style={{ padding: 'var(--space-4)' }}>
    <Card ruled flush title="Trade history">
      <div className="lx-table-wrap">
        <table className="lx-table">
          <thead>
            <tr>
              <th>Ticket</th><th>Symbol</th><th>Side</th><th>Lots</th>
              <th>Open</th><th>Close</th><th>P&amp;L</th><th>Closed at</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>#4820194</td><td>XAUUSD</td><td>Buy</td><td>0.50</td>
              <td>2,401.55</td><td>2,418.20</td><td className="lx-num">+$832.50</td><td>2026-08-19 14:22</td>
            </tr>
            <tr>
              <td>#4820201</td><td>EURUSD</td><td>Sell</td><td>1.25</td>
              <td>1.10240</td><td>1.10515</td><td className="lx-num">-$343.75</td><td>2026-08-19 16:04</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  </div>
)

/**
 * Form controls, for the tap-target and iOS-zoom assertions. Every control here
 * must clear --touch-min and render at or above --input-font-mobile below the
 * md breakpoint.
 */
export const Forms = () => (
  <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
    <Card title="Withdraw funds">
      <label className="input-label" htmlFor="rs-amount">Amount</label>
      <input id="rs-amount" className="input-field" defaultValue="8420.00" />

      <label className="input-label" htmlFor="rs-method">Method</label>
      <select id="rs-method" className="select-field" defaultValue="bank">
        <option value="bank">Bank transfer</option>
        <option value="crypto">Crypto (USDT)</option>
      </select>

      <label className="input-label" htmlFor="rs-note">Note to the desk</label>
      <textarea id="rs-note" className="textarea-field" rows={3} defaultValue="Monthly payout." />

      <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
        <Button>Request payout</Button>
        <Button variant="secondary">Cancel</Button>
      </div>
    </Card>
  </div>
)
