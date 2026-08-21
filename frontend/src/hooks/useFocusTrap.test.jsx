import React, { useRef, useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import useFocusTrap from './useFocusTrap'

/**
 * The trap is load-bearing for every dialog surface in the app (AdminModal
 * alone has 11 call sites), so the behaviours it promises are asserted here
 * rather than left to a manual pass.
 *
 * requestAnimationFrame is faked so the deferred initial-focus call is
 * deterministic; jsdom would otherwise run it on a real frame that the test has
 * already finished waiting for.
 */

function Dialog({ open, onClose, useInitialRef = false, children }) {
  const closeRef = useRef(null)
  const panelRef = useFocusTrap(open, onClose, useInitialRef ? { initialFocusRef: closeRef } : {})
  if (!open) return null
  return (
    <div ref={panelRef} role="dialog" aria-label="Test dialog">
      <button type="button">first</button>
      {children}
      <button type="button" ref={closeRef}>close</button>
    </div>
  )
}

function Harness({ useInitialRef = false }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>open dialog</button>
      <button type="button">outside</button>
      <Dialog open={open} onClose={() => setOpen(false)} useInitialRef={useInitialRef}>
        <button type="button">middle</button>
      </Dialog>
    </div>
  )
}

/**
 * Render, then flush the rAF the hook defers its initial focus behind.
 *
 * The trigger is focused explicitly first because jsdom's fireEvent.click does
 * not move focus the way a real click does. Without it document.activeElement
 * is <body> when the dialog opens, and the focus-restore assertion would be
 * testing jsdom's gap rather than the hook.
 */
function renderAndOpen(ui) {
  vi.useFakeTimers()
  const utils = render(ui)
  const trigger = screen.getByText('open dialog')
  trigger.focus()
  fireEvent.click(trigger)
  act(() => { vi.advanceTimersByTime(32) })
  return utils
}

describe('useFocusTrap', () => {
  it('moves focus into the dialog on open', () => {
    renderAndOpen(<Harness />)
    expect(document.activeElement).toBe(screen.getByText('first'))
    vi.useRealTimers()
  })

  it('honours initialFocusRef over the first focusable node', () => {
    renderAndOpen(<Harness useInitialRef />)
    expect(document.activeElement).toBe(screen.getByText('close'))
    vi.useRealTimers()
  })

  it('closes on Escape', () => {
    renderAndOpen(<Harness />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('wraps Tab from the last focusable node back to the first', () => {
    renderAndOpen(<Harness />)
    screen.getByText('close').focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('first'))
    vi.useRealTimers()
  })

  it('wraps Shift+Tab from the first focusable node to the last', () => {
    renderAndOpen(<Harness />)
    screen.getByText('first').focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('close'))
    vi.useRealTimers()
  })

  it('leaves Tab alone in the middle of the cycle, so the browser moves focus', () => {
    renderAndOpen(<Harness />)
    screen.getByText('middle').focus()
    // Not prevented: the browser's own sequential navigation handles interior
    // steps. Only the two boundaries are intercepted.
    const prevented = !fireEvent.keyDown(document, { key: 'Tab' })
    expect(prevented).toBe(false)
    vi.useRealTimers()
  })

  it('returns focus to the element that opened it', () => {
    renderAndOpen(<Harness />)
    const trigger = screen.getByText('open dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
    vi.useRealTimers()
  })

  it('does not listen while closed', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<Dialog open={false} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('calls the latest onClose, not the one captured when it opened', () => {
    // Guards the latest-ref pattern: callers pass inline arrows, so a stale
    // closure here would close a dialog by calling last render's handler.
    vi.useFakeTimers()
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Dialog open onClose={first} />)
    act(() => { vi.advanceTimersByTime(32) })
    rerender(<Dialog open onClose={second} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
