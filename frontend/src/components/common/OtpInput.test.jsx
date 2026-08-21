import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import OtpInput from './OtpInput'

/**
 * The shared OTP input, used by TOTP sign-in (trader and admin) and by phone
 * verification during registration.
 *
 * It gates account access and payout confirmation, and it had no test. The
 * behaviours below are the ones a user hits every time: auto-advance, backspace
 * back through the boxes, and paste-to-fill from an SMS or authenticator app —
 * paste being the one people actually use and the one most likely to break
 * silently, since a partial paste must not half-fill the boxes.
 */

function boxes() {
  return screen.getAllByRole('textbox')
}

/** The component focuses box 0 behind a rAF; flush it deterministically. */
function renderOtp(props = {}) {
  vi.useFakeTimers()
  const utils = render(<OtpInput {...props} />)
  act(() => { vi.advanceTimersByTime(32) })
  return utils
}

describe('OtpInput', () => {
  it('renders one box per digit', () => {
    renderOtp({ length: 6 })
    expect(boxes()).toHaveLength(6)
    vi.useRealTimers()
  })

  it('advances focus as digits are typed', () => {
    renderOtp()
    const inputs = boxes()
    fireEvent.change(inputs[0], { target: { value: '1' } })
    expect(document.activeElement).toBe(inputs[1])
    fireEvent.change(inputs[1], { target: { value: '2' } })
    expect(document.activeElement).toBe(inputs[2])
    vi.useRealTimers()
  })

  it('ignores non-numeric input', () => {
    const onChange = vi.fn()
    renderOtp({ onChange })
    fireEvent.change(boxes()[0], { target: { value: 'a' } })
    expect(boxes()[0]).toHaveValue('')
    vi.useRealTimers()
  })

  it('steps focus back on Backspace in an empty box', () => {
    renderOtp()
    const inputs = boxes()
    fireEvent.change(inputs[0], { target: { value: '1' } })
    // Focus is now on box 1, which is empty.
    fireEvent.keyDown(inputs[1], { key: 'Backspace' })
    expect(document.activeElement).toBe(inputs[0])
    vi.useRealTimers()
  })

  it('does not step back when the current box still has a digit', () => {
    // Otherwise one Backspace both clears the digit and jumps, so the previous
    // digit is the one that ends up deleted.
    renderOtp()
    const inputs = boxes()
    fireEvent.change(inputs[0], { target: { value: '1' } })
    inputs[0].focus()
    fireEvent.keyDown(inputs[0], { key: 'Backspace' })
    expect(document.activeElement).toBe(inputs[0])
    vi.useRealTimers()
  })

  it('fills every box from a pasted code and reports completion once', () => {
    const onComplete = vi.fn()
    renderOtp({ onComplete })
    fireEvent.paste(boxes()[0], {
      clipboardData: { getData: () => '123456' },
    })
    expect(boxes().map((b) => b.value)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith('123456')
    vi.useRealTimers()
  })

  it('strips separators out of a pasted code', () => {
    // Authenticator apps and SMS commonly render the code as "123 456".
    const onComplete = vi.fn()
    renderOtp({ onComplete })
    fireEvent.paste(boxes()[0], { clipboardData: { getData: () => '123 456' } })
    expect(onComplete).toHaveBeenCalledWith('123456')
    vi.useRealTimers()
  })

  it('ignores a paste that is not the full length', () => {
    // A half-filled set of boxes with focus at the end is worse than nothing:
    // the user cannot tell which box is short.
    const onComplete = vi.fn()
    renderOtp({ onComplete })
    fireEvent.paste(boxes()[0], { clipboardData: { getData: () => '123' } })
    expect(boxes().map((b) => b.value)).toEqual(['', '', '', '', '', ''])
    expect(onComplete).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('fires onComplete only when the last box is filled', () => {
    const onComplete = vi.fn()
    renderOtp({ length: 3, onComplete })
    const inputs = boxes()
    fireEvent.change(inputs[0], { target: { value: '1' } })
    fireEvent.change(inputs[1], { target: { value: '2' } })
    expect(onComplete).not.toHaveBeenCalled()
    fireEvent.change(inputs[2], { target: { value: '3' } })
    expect(onComplete).toHaveBeenCalledWith('123')
    vi.useRealTimers()
  })

  it('clears every box when resetKey changes', () => {
    // The reset path after a rejected code. If it did not clear, the user would
    // be retyping over digits the server already refused.
    const { rerender } = renderOtp({ resetKey: 0 })
    fireEvent.change(boxes()[0], { target: { value: '9' } })
    expect(boxes()[0]).toHaveValue('9')

    rerender(<OtpInput resetKey={1} />)
    expect(boxes().map((b) => b.value)).toEqual(['', '', '', '', '', ''])
    vi.useRealTimers()
  })

  it('does not accept input while disabled', () => {
    renderOtp({ disabled: true })
    for (const box of boxes()) expect(box).toBeDisabled()
    vi.useRealTimers()
  })
})
