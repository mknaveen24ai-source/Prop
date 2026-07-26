import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'

function formatMoney(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? `$${parsed.toLocaleString()}` : 'N/A'
}

function PhaseRow({ model, phase, phaseIndex, onSave, saving }) {
  const [draft, setDraft] = useState({
    profit_target_pct: model.profit_targets_pct[phaseIndex],
    max_time_limit_days: model.time_limits_days[phaseIndex],
    consistency_rule_pct: Array.isArray(model.consistency_max_day_pct_by_phase)
      ? model.consistency_max_day_pct_by_phase[phaseIndex]
      : model.consistency_max_day_pct,
    trailing_max_drawdown_pct: model.max_drawdown_pct,
    daily_loss_limit_pct: model.daily_drawdown_pct,
    min_trading_days: model.min_trading_days
  })

  function update(key, value) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const fields = [
    ['profit_target_pct', 'Profit Target %'],
    ['trailing_max_drawdown_pct', 'Trailing Max DD %'],
    ['daily_loss_limit_pct', 'Daily Loss %'],
    ['min_trading_days', 'Min Trading Days'],
    ['max_time_limit_days', 'Time Limit (days)'],
    ['consistency_rule_pct', 'Consistency %'],
  ]

  return (
    <tr>
      <td style={{ padding: '8px 10px', fontWeight: 600 }}>Phase {phaseIndex + 1}</td>
      {fields.map(([key]) => (
        <td key={key} style={{ padding: '6px 8px' }}>
          <input
            type="number"
            value={draft[key]}
            onChange={(e) => update(key, e.target.value)}
            style={{ width: '90px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }}
          />
        </td>
      ))}
      <td style={{ padding: '6px 8px' }}>
        <button
          className="admin-btn admin-btn-sm"
          disabled={saving}
          onClick={() => onSave(phaseIndex + 1, draft)}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </td>
    </tr>
  )
}

function PricingRow({ model, sizeInfo, onSave, saving }) {
  const [price, setPrice] = useState(sizeInfo.price)
  const [isActive, setIsActive] = useState(sizeInfo.is_active)

  return (
    <tr>
      <td style={{ padding: '8px 10px', fontWeight: 600 }}>{formatMoney(sizeInfo.account_size)}</td>
      <td style={{ padding: '6px 8px' }}>
        <input
          type="number"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          style={{ width: '90px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }}
        />
      </td>
      <td style={{ padding: '6px 8px' }}>
        <select
          value={isActive ? 'true' : 'false'}
          onChange={(e) => setIsActive(e.target.value === 'true')}
          style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }}
        >
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </td>
      <td style={{ padding: '6px 8px' }}>
        <button
          className="admin-btn admin-btn-sm"
          disabled={saving}
          onClick={() => onSave(sizeInfo.account_size, { price, is_active: isActive })}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </td>
    </tr>
  )
}

function StepModelCard({ model, onToggle, onSavePhase, onSavePricing }) {
  const [savingPhase, setSavingPhase] = useState(null)
  const [savingSize, setSavingSize] = useState(null)
  const [toggling, setToggling] = useState(false)

  async function handleToggle() {
    setToggling(true)
    try {
      await onToggle(model.slug, !model.is_active)
    } finally {
      setToggling(false)
    }
  }

  async function handleSavePhase(phaseIndex, draft) {
    setSavingPhase(phaseIndex)
    try {
      await onSavePhase(model.slug, phaseIndex, draft)
    } finally {
      setSavingPhase(null)
    }
  }

  async function handleSavePricing(accountSize, draft) {
    setSavingSize(accountSize)
    try {
      await onSavePricing(model.slug, accountSize, draft)
    } finally {
      setSavingSize(null)
    }
  }

  return (
    <div className="admin-card" style={{ marginBottom: '24px', padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h3 style={{ margin: 0 }}>{model.name}</h3>
          <div style={{ fontSize: '12px', opacity: 0.7 }}>{model.description}</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: model.is_active ? 'var(--admin-success)' : 'var(--admin-text-muted)' }}>
            {model.is_active ? 'Enabled' : 'Disabled'}
          </span>
          <input type="checkbox" checked={model.is_active} disabled={toggling} onChange={handleToggle} />
        </label>
      </div>

      <div style={{ overflowX: 'auto', marginBottom: '18px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.7 }}>
              <th style={{ padding: '6px 10px' }}>Phase</th>
              <th style={{ padding: '6px 8px' }}>Profit Target %</th>
              <th style={{ padding: '6px 8px' }}>Trailing Max DD %</th>
              <th style={{ padding: '6px 8px' }}>Daily Loss %</th>
              <th style={{ padding: '6px 8px' }}>Min Trading Days</th>
              <th style={{ padding: '6px 8px' }}>Time Limit (days)</th>
              <th style={{ padding: '6px 8px' }}>Consistency %</th>
              <th style={{ padding: '6px 8px' }}></th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: model.steps }).map((_, idx) => (
              <PhaseRow
                key={idx}
                model={model}
                phase={idx + 1}
                phaseIndex={idx}
                onSave={handleSavePhase}
                saving={savingPhase === idx + 1}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.7 }}>
              <th style={{ padding: '6px 10px' }}>Account Size</th>
              <th style={{ padding: '6px 8px' }}>Price (USD)</th>
              <th style={{ padding: '6px 8px' }}>Status</th>
              <th style={{ padding: '6px 8px' }}></th>
            </tr>
          </thead>
          <tbody>
            {model.pricing.map((sizeInfo) => (
              <PricingRow
                key={sizeInfo.account_size}
                model={model}
                sizeInfo={sizeInfo}
                onSave={handleSavePricing}
                saving={savingSize === sizeInfo.account_size}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function AdminStepModels() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()
  const [models, setModels] = useState([])
  const [loading, setLoading] = useState(true)

  const loadModels = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/step-models')
      setModels(Array.isArray(res.data) ? res.data : [])
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not load challenge models')
    } finally {
      setLoading(false)
    }
  }, [adminAxios, toast])

  useEffect(() => { loadModels() }, [loadModels])

  async function handleToggle(slug, enabled) {
    try {
      await adminAxios.post(`/api/admin/step-models/${slug}/toggle`, { enabled })
      toast.success(`${slug} ${enabled ? 'enabled' : 'disabled'}`)
      loadModels()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not toggle model')
    }
  }

  async function handleSavePhase(slug, phaseIndex, draft) {
    try {
      await adminAxios.patch(`/api/admin/step-models/${slug}/phases/${phaseIndex}`, draft)
      toast.success(`Phase ${phaseIndex} rules saved`)
      loadModels()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not save phase rules')
    }
  }

  async function handleSavePricing(slug, accountSize, draft) {
    try {
      await adminAxios.patch(`/api/admin/step-models/${slug}/pricing/${accountSize}`, draft)
      toast.success(`${formatMoney(accountSize)} pricing saved`)
      loadModels()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not save pricing')
    }
  }

  if (loading) {
    return <div style={{ padding: '32px', opacity: 0.7 }}>Loading challenge models...</div>
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ margin: '0 0 4px' }}>Challenge Models</h2>
        <p style={{ margin: 0, opacity: 0.7, fontSize: '13px' }}>
          Manage the 1-step, 2-step, and 3-step challenge models: enable/disable, edit phase rules, and edit pricing per account size. Changes apply platform-wide immediately.
        </p>
      </div>

      {models.map((model) => (
        <StepModelCard
          key={model.slug}
          model={model}
          onToggle={handleToggle}
          onSavePhase={handleSavePhase}
          onSavePricing={handleSavePricing}
        />
      ))}
    </div>
  )
}
