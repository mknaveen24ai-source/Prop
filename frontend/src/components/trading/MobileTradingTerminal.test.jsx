import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import MobileTradingTerminal from './MobileTradingTerminal'

// The mobile terminal exists because stacking the desktop desk still leaves the
// order ticket a scroll away from the price. These tests pin the two things
// that makes concrete: every pane is reachable without leaving the screen, and
// the BUY/SELL bar places the *same* order the desktop panel does.

vi.mock('../TradingViewWidget', () => ({
  // The real widget injects a third-party script and an iframe.
  default: ({ symbol }) => <div data-testid="chart">{symbol}</div>,
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-08T10:00:00Z')) // Wednesday, market open
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

const PRICES = { EURUSD: { bid: '1.10000', ask: '1.10020' }, XAUUSD: { bid: '2400.00', ask: '2400.40' } }
const ACCOUNT = { id: 1, current_balance: '10000', account_type: 'phase1', account_size: '10000' }

const POSITION = {
  id: 7,
  instrument: 'EURUSD',
  direction: 'buy',
  status: 'open',
  lot_size: '0.50',
  open_price: '1.10000',
  current_price: '1.10250',
  stop_loss: '1.09800',
  take_profit: '1.10800',
  floating_pnl: 125.5,
}

function setup(overrides = {}) {
  const handleOpenTrade = vi.fn().mockResolvedValue(undefined)
  const handleCloseTrade = vi.fn().mockResolvedValue(undefined)
  const setOrderForm = vi.fn()
  const orderForm = { instrument: 'EURUSD', lots: '0.50', stop_loss: '', take_profit: '' }

  const utils = render(
    <MobileTradingTerminal
      prices={PRICES}
      theme="dark"
      selectedAccount={ACCOUNT}
      floatingBalance={10125.5}
      floatingProfit={125.5}
      availableInstruments={['EURUSD', 'XAUUSD']}
      orderForm={orderForm}
      setOrderForm={setOrderForm}
      handleOpenTrade={handleOpenTrade}
      openPositions={[POSITION]}
      pendingOrders={[]}
      closingTradeSet={new Set()}
      handleCloseTrade={handleCloseTrade}
      handlePartialClose={vi.fn()}
      partialForm={null}
      setPartialForm={vi.fn()}
      modifyingTradeId={null}
      modifyForm={{ stop_loss: '', take_profit: '' }}
      setModifyForm={vi.fn()}
      modifyError=""
      modifySuccess=""
      openModifyForm={vi.fn()}
      cancelModify={vi.fn()}
      submitModify={vi.fn()}
      moveTradeToBreakeven={vi.fn()}
      onCancelOrder={vi.fn()}
      pinnedInstruments={['EURUSD']}
      priceHistory={{ EURUSD: [{ value: 1.1 }, { value: 1.102 }] }}
      isPinned={() => true}
      togglePin={vi.fn()}
      {...overrides}
    />
  )
  return { ...utils, handleOpenTrade, handleCloseTrade, setOrderForm }
}

describe('MobileTradingTerminal', () => {
  it('keeps the live price visible in the header alongside the chart', () => {
    const { container } = setup()
    const header = container.querySelector('.mterm__header')

    // The point of the sticky header: the symbol and both sides of the quote
    // stay on screen whichever pane is showing.
    expect(within(header).getByText('EURUSD')).toBeInTheDocument()
    expect(within(header).getByText(/1\.10000/)).toBeInTheDocument() // bid
    expect(within(header).getByText(/1\.10020/)).toBeInTheDocument() // ask
    expect(screen.getByTestId('chart')).toHaveTextContent('EURUSD')
  })

  it('reaches positions, orders and watchlist without leaving the screen', () => {
    const { container } = setup()
    const pane = () => container.querySelector('.mterm__pane')

    fireEvent.click(screen.getByRole('tab', { name: /positions/i }))
    expect(within(pane()).getByText('+$125.50')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /orders/i }))
    expect(within(pane()).getByText(/no pending orders/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /watchlist/i }))
    expect(within(pane()).getByText('EURUSD')).toBeInTheDocument()
  })

  it('opens the ticket already committed to a direction and submits a market order', async () => {
    const { handleOpenTrade } = setup()

    fireEvent.click(screen.getByRole('button', { name: /^buy/i }))

    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByText(/Buy EURUSD/i)).toBeInTheDocument()

    fireEvent.click(within(sheet).getByRole('button', { name: /confirm buy/i }))

    // Byte-identical to what OrderPanel sends — both go through useOrderTicket.
    expect(handleOpenTrade).toHaveBeenCalledWith({
      direction: 'buy',
      orderType: 'market',
      pendingPrice: null,
    })
  })

  it('submits a SELL from the same bar', async () => {
    const { handleOpenTrade } = setup()
    fireEvent.click(screen.getByRole('button', { name: /^sell/i }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /confirm sell/i }))
    expect(handleOpenTrade).toHaveBeenCalledWith({
      direction: 'sell',
      orderType: 'market',
      pendingPrice: null,
    })
  })

  it('steps lot size without a keypad', () => {
    const { setOrderForm } = setup()
    fireEvent.click(screen.getByRole('button', { name: /^buy/i }))
    fireEvent.click(screen.getByRole('button', { name: /increase lot size/i }))

    const updater = setOrderForm.mock.calls.at(-1)[0]
    expect(updater({ lots: '0.50' })).toEqual({ lots: '0.51' })
  })

  it('requires a second tap to close a position', () => {
    const { handleCloseTrade } = setup()
    fireEvent.click(screen.getByRole('tab', { name: /positions/i }))

    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    // First tap only arms the confirm — an accidental brush must not close a
    // live position.
    expect(handleCloseTrade).not.toHaveBeenCalled()
    expect(screen.getByText(/close this position\?/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /confirm close/i }))
    expect(handleCloseTrade).toHaveBeenCalledWith(POSITION)
  })

  it('places a pending order from the phone, not just market orders', async () => {
    const { handleOpenTrade } = setup()

    fireEvent.click(screen.getByRole('button', { name: /^buy/i }))
    const sheet = screen.getByRole('dialog')

    fireEvent.click(within(sheet).getByRole('tab', { name: /pending/i }))

    // Only the two BUY-side types are offered — the trader already committed
    // to a direction by tapping BUY, and flipping it silently would be worse
    // than showing fewer options.
    expect(within(sheet).getByRole('button', { name: /^Buy Limit/ })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: /^Buy Stop/ })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: /^Sell Limit/ })).not.toBeInTheDocument()

    // No trigger price yet, so the order cannot be placed.
    expect(within(sheet).getByRole('button', { name: /place buy limit/i })).toBeDisabled()

    fireEvent.change(within(sheet).getByLabelText(/trigger price/i), { target: { value: '1.09000' } })
    fireEvent.click(within(sheet).getByRole('button', { name: /place buy limit/i }))

    expect(handleOpenTrade).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'buy',
      orderType: 'buy_limit',
      pendingPrice: 1.09,
      ocoSibling: null,
    }))
  })

  it('offers the sell-side pending types when SELL was tapped', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /^sell/i }))
    const sheet = screen.getByRole('dialog')
    fireEvent.click(within(sheet).getByRole('tab', { name: /pending/i }))

    expect(within(sheet).getByRole('button', { name: /^Sell Limit/ })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: /^Sell Stop/ })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: /^Buy Limit/ })).not.toBeInTheDocument()
  })

  it('disables the commit bar when there is no account', () => {
    setup({ selectedAccount: null })
    expect(screen.getByRole('button', { name: /^buy/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^sell/i })).toBeDisabled()
  })

  it('gives numeric fields a decimal keypad', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /^buy/i }))
    const sheet = screen.getByRole('dialog')
    // Exact labels: /lot size/i would also match the stepper buttons'
    // "Increase lot size" / "Decrease lot size" aria-labels.
    for (const label of ['Lot size', 'Stop loss', 'Take profit']) {
      expect(within(sheet).getByLabelText(label)).toHaveAttribute('inputmode', 'decimal')
    }
  })
})
