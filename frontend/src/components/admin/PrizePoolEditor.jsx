import React from 'react'

const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }

const DEFAULT_ACCOUNT_SIZES = [5000, 10000, 25000, 50000, 100000, 200000, 400000]

// Editable list of { rank, label, voucher? } prize rows — { rank, label } matches
// the shape stored in competitions.prize_pool_json and already rendered on the
// public competition page. `voucher` is an optional structured extension
// ({ account_size, challenge_model_slug }) — when present, finalizeCompetition
// issues a redeemable free-challenge-account voucher to whichever entry lands
// on that rank, on top of the always-shown free-text `label`.
export default function PrizePoolEditor({ prizes, onChange, stepModels = [], accountSizes = DEFAULT_ACCOUNT_SIZES }) {
  function updateRow(index, key, value) {
    const next = prizes.map((p, i) => (i === index ? { ...p, [key]: value } : p))
    onChange(next)
  }

  function updateVoucher(index, patch) {
    const next = prizes.map((p, i) => (i === index ? { ...p, voucher: { ...(p.voucher || {}), ...patch } } : p))
    onChange(next)
  }

  function toggleVoucher(index, enabled) {
    const next = prizes.map((p, i) => {
      if (i !== index) return p
      if (!enabled) {
        const { voucher, ...rest } = p
        return rest
      }
      return { ...p, voucher: { account_size: accountSizes[0], challenge_model_slug: stepModels[0]?.slug || '' } }
    })
    onChange(next)
  }

  function addRow() {
    const nextRank = prizes.length > 0 ? Math.max(...prizes.map((p) => parseInt(p.rank, 10) || 0)) + 1 : 1
    onChange([...prizes, { rank: nextRank, label: '' }])
  }

  function removeRow(index) {
    onChange(prizes.filter((_, i) => i !== index))
  }

  return (
    <div>
      <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: '8px' }}>Prizes (shown to traders on the competition page)</div>
      {prizes.map((p, idx) => (
        <div key={idx} style={{ border: '1px solid var(--admin-border)', borderRadius: '8px', padding: '10px', marginBottom: '10px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: p.voucher ? '10px' : 0 }}>
            <input
              type="number"
              min="1"
              style={{ ...inputStyle, width: '80px' }}
              placeholder="Rank"
              value={p.rank}
              onChange={(e) => updateRow(idx, 'rank', e.target.value)}
            />
            <input
              style={inputStyle}
              placeholder='e.g. "$500" or "Trophy + $200"'
              value={p.label}
              onChange={(e) => updateRow(idx, 'label', e.target.value)}
            />
            <button type="button" className="admin-btn admin-btn-sm" onClick={() => removeRow(idx)}>Remove</button>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--fs-sm)', opacity: 0.85 }}>
            <input type="checkbox" checked={!!p.voucher} onChange={(e) => toggleVoucher(idx, e.target.checked)} />
            Grant a free challenge account voucher to this rank
          </label>

          {p.voucher && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <select
                className="admin-select"
                style={{ flex: 1 }}
                value={p.voucher.account_size}
                onChange={(e) => updateVoucher(idx, { account_size: parseInt(e.target.value, 10) })}
              >
                {accountSizes.map((size) => (
                  <option key={size} value={size}>${size.toLocaleString()}</option>
                ))}
              </select>
              <select
                className="admin-select"
                style={{ flex: 1 }}
                value={p.voucher.challenge_model_slug}
                onChange={(e) => updateVoucher(idx, { challenge_model_slug: e.target.value })}
              >
                <option value="">- select challenge model -</option>
                {stepModels.map((m) => (
                  <option key={m.slug} value={m.slug}>{m.name || m.slug}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      ))}
      <button type="button" className="admin-btn admin-btn-sm" onClick={addRow}>+ Add Prize</button>
    </div>
  )
}
