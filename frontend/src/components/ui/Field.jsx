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
  const [revealed, setRevealed] = useState(false)
  const isSecret = secret || type === 'password'

  const controlClasses = [
    'lx-field__control',
    mono ? 'lx-field__control--mono' : '',
    error ? 'lx-field__control--invalid' : '',
  ].filter(Boolean).join(' ')

  function renderControl() {
    if (type === 'textarea') {
      return <textarea id={controlId} className={controlClasses} {...rest} />
    }
    if (type === 'select') {
      const opts = (options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
      return (
        <select id={controlId} className={controlClasses} {...rest}>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )
    }
    if (isSecret) {
      return (
        <div className="lx-field__affix">
          <input id={controlId} type={revealed ? 'text' : 'password'} className={controlClasses} {...rest} />
          <button
            type="button"
            className="lx-field__reveal"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? 'Hide value' : 'Reveal value'}
            title={revealed ? 'Hide value' : 'Reveal value'}
          >
            <EyeIcon hidden={!revealed} size={16} />
          </button>
        </div>
      )
    }
    return <input id={controlId} type={type} className={controlClasses} {...rest} />
  }

  return (
    <div className={['lx-field', className].filter(Boolean).join(' ')}>
      {label && <label className="lx-field__label" htmlFor={controlId}>{label}</label>}
      {renderControl()}
      {hint && !error && <span className="lx-field__hint">{hint}</span>}
      {error && <span className="lx-field__error">{error}</span>}
    </div>
  )
}
