import React, { useId, useState } from 'react'
import EyeIcon from './EyeIcon'

/**
 * Ledger Desk form field — label + control + hint/error, flat and
 * hairline-bordered. One component covers text/number/select/textarea/
 * password so admin forms and auth forms stop hand-rolling this markup.
 *
 * type: 'text' | 'number' | 'textarea' | 'select' | 'password' (default 'text')
 * options: [{ value, label }] or plain strings — required when type='select'
 * mono: right-align numerals in a tabular monospace (for ids, amounts, keys)
 * secret: alias for type='password' with a reveal toggle — masked by default,
 *         used for API keys / webhook secrets so they aren't shown in the clear.
 *
 * ── Error and hint linkage ───────────────────────────────────────────────────
 *
 * The label was already tied to the control by htmlFor/useId. The hint and the
 * error were not tied to anything: they rendered next to the input and were
 * announced, if at all, only when a screen-reader user happened to arrow past
 * them — never when focus landed on the field they describe. So the one moment
 * that matters, tabbing into an invalid field, said nothing.
 *
 * aria-describedby fixes that, and aria-invalid marks the field itself as
 * failing rather than leaving the red border to carry the meaning. The error
 * also takes role="alert" so it is announced when it appears, not only when
 * focus reaches it.
 */
export default function Field({
  label,
  hint,
  error,
  type = 'text',
  options,
  mono = false,
  secret = false,
  id,
  className = '',
  ...rest
}) {
  const autoId = useId()
  const controlId = id || autoId
  const errorId = `${controlId}-error`
  const hintId = `${controlId}-hint`
  const [revealed, setRevealed] = useState(false)
  const isSecret = secret || type === 'password'

  const controlClasses = [
    'lx-field__control',
    mono ? 'lx-field__control--mono' : '',
    error ? 'lx-field__control--invalid' : '',
  ].filter(Boolean).join(' ')

  // The hint is replaced by the error when there is one (see the render below),
  // so only the visible one is ever referenced — pointing at an unrendered id
  // makes the whole aria-describedby resolve to nothing in some screen readers.
  const describedBy = [
    error ? errorId : null,
    hint && !error ? hintId : null,
    // Preserve a caller-supplied describedby instead of silently dropping it.
    rest['aria-describedby'] || null,
  ].filter(Boolean).join(' ') || undefined

  // Pulled out of `rest` so the spread below cannot overwrite what we compute.
  const { 'aria-describedby': _callerDescribedBy, ...controlProps } = rest

  const a11yProps = {
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
  }

  function renderControl() {
    if (type === 'textarea') {
      return <textarea id={controlId} className={controlClasses} {...a11yProps} {...controlProps} />
    }
    if (type === 'select') {
      const opts = (options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
      return (
        <select id={controlId} className={controlClasses} {...a11yProps} {...controlProps}>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )
    }
    if (isSecret) {
      return (
        <div className="lx-field__affix">
          <input
            id={controlId}
            type={revealed ? 'text' : 'password'}
            className={controlClasses}
            {...a11yProps}
            {...controlProps}
          />
          <button
            type="button"
            className="lx-field__reveal"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? 'Hide value' : 'Reveal value'}
            aria-pressed={revealed}
            title={revealed ? 'Hide value' : 'Reveal value'}
          >
            <EyeIcon hidden={!revealed} size={16} />
          </button>
        </div>
      )
    }
    return <input id={controlId} type={type} className={controlClasses} {...a11yProps} {...controlProps} />
  }

  return (
    <div className={['lx-field', className].filter(Boolean).join(' ')}>
      {label && <label className="lx-field__label" htmlFor={controlId}>{label}</label>}
      {renderControl()}
      {hint && !error && <span className="lx-field__hint" id={hintId}>{hint}</span>}
      {/* role="alert" so a validation failure is announced as it appears.
          Errors here are shown after a submit or a blur, which is a change the
          user caused and expects feedback from — the case assertive live
          regions are for. */}
      {error && <span className="lx-field__error" id={errorId} role="alert">{error}</span>}
    </div>
  )
}
