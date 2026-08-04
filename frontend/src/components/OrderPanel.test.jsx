import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import OrderPanel from './OrderPanel'

// Pin the clock to a weekday well clear of the daily rollover window so the
// component's own getMarketStatus() (which reads real wall-clock time) is
// deterministic instead of depending on when the suite happens to run.
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-08T10:00:00Z')) // Wednesday, market open
})
afterEach(() => {
  vi.useRealTimers()
})

const PRICES = { EURUSD: { bid: '1.10000', ask: '1.10020' } }
const ACCOUNT = { current_balance: '10000', account_type: 'phase1', account_size: '10000' }

function setup(overrides = {}) {
  const onOpenTrade = vi.fn().mockResolvedValue(undefined)
  const setOrderForm = vi.fn()
  const orderForm = { instrument: 'EURUSD', lots: '1', stop_loss: '', take_profit: '', ...overrides.orderForm }

  const utils = render(
    <OrderPanel
      prices={PRICES}
      selectedAccount={ACCOUNT}
      floatingBalance={10000}
      onOpenTrade={onOpenTrade}
      orderForm={orderForm}
      setOrderForm={setOrderForm}
      {...overrides.props}
    />
  )
  return { ...utils, onOpenTrade, setOrderForm }
}

describe('OrderPanel', () => {
  it('shows MARKET OPEN and enables the buy/sell buttons when an account and price are available', () => {
    setup()
    expect(screen.getByText('MARKET OPEN')).toBeInTheDocument()
    expect(screen.getByText('BUY').closest('button')).not.toBeDisabled()
    expect(screen.getByText('SELL').closest('button')).not.toBeDisabled()
  })

  it('disables the buy/sell buttons when there is no selected account', () => {
    setup({ props: { selectedAccount: null } })
    expect(screen.getByText('BUY').closest('button')).toBeDisabled()
    expect(screen.getByText('SELL').closest('button')).toBeDisabled()
  })

  it('disables the buy/sell buttons when there is no live price for the instrument', () => {
    setup({ props: { prices: {} } })
    expect(screen.getByText('BUY').closest('button')).toBeDisabled()
  })

  it('submits a market BUY order at the ask price with no pending price', async () => {
    const { onOpenTrade } = setup()
    fireEvent.click(screen.getByText('BUY').closest('button'))
    expect(onOpenTrade).toHaveBeenCalledWith({
      direction: 'buy',
      orderType: 'market',
      pendingPrice: null
    })
  })

  it('submits a market SELL order', async () => {
    const { onOpenTrade } = setup()
    fireEvent.click(screen.getByText('SELL').closest('button'))
    expect(onOpenTrade).toHaveBeenCalledWith({
      direction: 'sell',
      orderType: 'market',
      pendingPrice: null
    })
  })

  it('updates the lot size field through setOrderForm', () => {
    const { setOrderForm } = setup()
    const lotsInput = screen.getByPlaceholderText('0.01')
    fireEvent.change(lotsInput, { target: { value: '2.5' } })
    expect(setOrderForm).toHaveBeenCalled()
    const updater = setOrderForm.mock.calls[0][0]
    expect(updater({ lots: '1' })).toEqual({ lots: '2.5' })
  })

  it('does not submit a pending order when no price has been entered', () => {
    const { onOpenTrade } = setup()
    fireEvent.click(screen.getByText('Pending'))
    const placeButton = screen.getByText(/Place BUY LIMIT/i).closest('button')
    expect(placeButton).toBeDisabled()
    fireEvent.click(placeButton)
    expect(onOpenTrade).not.toHaveBeenCalled()
  })

  it('submits a pending buy_limit order with the entered trigger price', () => {
    const { onOpenTrade } = setup()
    fireEvent.click(screen.getByText('Pending'))
    // Stop loss, take profit, and the pending-order price input all share an
    // "e.g. ..." placeholder pattern — the pending price is the last one
    // rendered once the Pending panel is open.
    const priceInputs = screen.getAllByPlaceholderText(/e\.g\./)
    const priceInput = priceInputs[priceInputs.length - 1]
    fireEvent.change(priceInput, { target: { value: '1.09000' } })
    fireEvent.click(screen.getByText(/Place BUY LIMIT/i).closest('button'))

    expect(onOpenTrade).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'buy',
      orderType: 'buy_limit',
      pendingPrice: 1.09,
      ocoSibling: null
    }))
  })
})
