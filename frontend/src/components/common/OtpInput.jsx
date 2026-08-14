import React, { useEffect, useRef, useState } from 'react'

// Shared N-digit code input — glass-backed boxes with auto-advance, backspace
// navigation, and paste-to-fill. Used by TOTP (Login, Admin login) and phone
// OTP (Register) flows, which previously each hand-rolled their own version.
export default function OtpInput({
  length = 6,
  onChange,
  onComplete,
  disabled = false,
  autoFocus = true,
  resetKey,
  idPrefix = 'otp-digit',
}) {
  const [digits, setDigits] = useState(() => Array(length).fill(''))
  const refs = useRef([])
  if (refs.current.length !== length) refs.current = Array(length).fill(null)

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (resetKey === undefined) return
    setDigits(Array(length).fill(''))
    refs.current[0]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  function updateDigits(next) {
    setDigits(next)
    const code = next.join('')
    onChange?.(code)
    if (next.every((d) => d !== '')) onComplete?.(code)
  }

  function handleDigit(index, value) {
    const digit = value.replace(/\D/g, '').slice(0, 1)
    const next = [...digits]
    next[index] = digit
    updateDigits(next)
    if (digit && index < length - 1) refs.current[index + 1]?.focus()
  }

  function handleKeyDown(index, event) {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      refs.current[index - 1]?.focus()
    }
  }

  function handlePaste(event) {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, length)
    if (pasted.length === length) {
      updateDigits(pasted.split(''))
      refs.current[length - 1]?.focus()
    }
  }

  return (
    <div className="otp-input-group" onPaste={handlePaste}>
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => { refs.current[index] = el }}
          id={`${idPrefix}-${index}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          value={digit}
          disabled={disabled}
          onChange={(event) => handleDigit(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          className={`otp-digit-box${digit ? ' is-filled' : ''}`}
          aria-label={`Digit ${index + 1}`}
        />
      ))}
    </div>
  )
}
