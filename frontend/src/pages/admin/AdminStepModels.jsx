import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import Card from '../../components/ui/Card'

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
      <td style={{ padding: 'var(--space-2) var(--space-2-5)', fontWeight: 600 }}>Phase {phaseIndex + 1}</td>
      {fields.map(([key]) => (
        <td key={key} style={{ padding: 'var(--space-1-5) var(--space-2)' }}>
          <input
            type="number"
            value={draft[key]}
            onChange={(e) => update(key, e.target.value)}
            style={{ width: '90px', padding: 'var(--space-1-5) var(--space-2)', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }}
          />
        </td>
      ))}
      <td style={{ padding: 'var(--space-1-5) var(--space-2)' }}>
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
  const [isUnlimited, setIsUnlimited] = useState(sizeInfo.is_unlimited)
  const [slotLimit, setSlotLimit] = useState(sizeInfo.slot_limit != null ? String(sizeInfo.slot_limit) : '')

  return (
    <tr>
      <td style={{ padding: 'var(--space-2) var(--space-2-5)', fontWeight: 600 }}>{formatMoney(sizeInfo.account_size)}</td>
      <td style={{ padding: 'var(--space-1-5) var(--space-2)' }}>
        <input
          type="number"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          style={{ width: '90px', padding: 'var(--space-1-5) var(--space-2)', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }}
        />
      </td>
      <td style={{ padding: 'var(--space-1-5) var(--space-2)' }}>
        <select
          value={isActive ? 'true' : 'false'}
          onChange={(e) => setIsActive(e.target.value === 'true')}
          style={{ padding: 'var(--space-1-5) var(--space-2)', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }}
        >
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </td>
      <td style={{ padding: 'var(--space-1-5) var(--space-2)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1-5)', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={isUnlimited} onChange={(e) => setIsUnlimited(e.target.checked)} />
          Unlimited
        </label>
      </td>
      <td style={{ padding: 'var(--space-1-5) var(--space-2)' }}>
        <input
          type="number"
          min="0"
          disabled={isUnlimited}
          value={slotLimit}
          onChange={(e) => setSlotLimit(e.target.value)}
          placeholder="Total slots"
          style={{ width: '100px', padding: 'var(--space-1-5) var(--space-2)', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit', opacity: isUnlimited ? 0.5 : 1 }}
        />
      </td>
      <td style={{ padding: 'var(--space-1-5) var(--space-2)', fontSize: 'var(--fs-sm)', opacity: 0.75, whiteSpace: 'nowrap' }}>
        {sizeInfo.used ?? 0} used / {sizeInfo.is_unlimited ? '∞' : (sizeInfo.remaining ?? 0)} left
      </td>
      <td style={{ padding: 'var(--space-1-5) var(--space-2)' }}>
        <button
          className="admin-btn admin-btn-sm"
          disabled={saving}
          onClick={() => onSave(sizeInfo.account_size, {
            price,
            is_active: isActive,
            is_unlimited: isUnlimited,
            slot_limit: isUnlimited ? null : slotLimit
          })}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </td>
    </tr>
  )
}

function ScalingSection({ model, onSave, saving }) {
  const [draft, setDraft] = useState({
    scaling_enabled: model.scaling_enabled,
    scaling_target_pct: model.scaling_target_pct,
    scaling_multiplier: model.scaling_multiplier,
    scaling_increase_per_milestone_pct: model.scaling_increase_per_milestone_pct ?? 0,
    scaling_max_account_size: model.scaling_max_account_size
  })

  function update(key, value) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const inputStyle = { width: '110px', padding: 'var(--space-1-5) var(--space-2)', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }

  return (
    <div style={{ marginTop: 'var(--space-4-5)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--admin-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2-5)' }}>
        <h4 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>Scaling Plan (funded stage)</h4>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1-5)', fontSize: 'var(--fs-sm)' }}>
          <input type="checkbox" checked={!!draft.scaling_enabled} onChange={(e) => update('scaling_enabled', e.target.checked)} />
          Enabled
        </label>
      </div>
      <p style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-2-5)' }}>
        Every milestone injects real capital into the trader's balance (via the ledger-backed balance-adjustment
        path) and raises their lot-size multiplier. Set the capital increase to 0 to keep the multiplier-only
        behavior with no balance change.
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-3-5)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label>
          <div style={{ fontSize: 'var(--fs-xs)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Milestone Every (% net profit)</div>
          <input type="number" min="0.1" step="0.1" style={inputStyle} value={draft.scaling_target_pct} onChange={(e) => update('scaling_target_pct', e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-xs)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Lot-Size Multiplier (x per milestone)</div>
          <input type="number" min="1.01" step="0.1" style={inputStyle} value={draft.scaling_multiplier} onChange={(e) => update('scaling_multiplier', e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-xs)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Capital Increase per Milestone (%)</div>
          <input type="number" min="0" step="1" style={inputStyle} value={draft.scaling_increase_per_milestone_pct} onChange={(e) => update('scaling_increase_per_milestone_pct', e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-xs)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Max Account Size ($)</div>
          <input type="number" min="1" step="1000" style={inputStyle} value={draft.scaling_max_account_size} onChange={(e) => update('scaling_max_account_size', e.target.value)} />
        </label>
        <button className="admin-btn admin-btn-sm" disabled={saving} onClick={() => onSave(model.slug, draft)}>
          {saving ? 'Saving...' : 'Save Scaling'}
        </button>
      </div>
    </div>
  )
}

function StepModelCard({ model, onToggle, onSavePhase, onSavePricing, onSaveScaling }) {
  const [savingPhase, setSavingPhase] = useState(null)
  const [savingSize, setSavingSize] = useState(null)
  const [savingScaling, setSavingScaling] = useState(false)
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

  async function handleSaveScaling(slug, draft) {
    setSavingScaling(true)
    try {
      await onSaveScaling(slug, draft)
    } finally {
      setSavingScaling(false)
    }
  }

  return (
    <Card style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
        <div>
          <h3 style={{ margin: 0 }}>{model.name}</h3>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7 }}>{model.description}</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
          <span style={{ fontSize: 'var(--fs-base)', fontWeight: 600, color: model.is_active ? 'var(--admin-success)' : 'var(--admin-text-muted)' }}>
            {model.is_active ? 'Enabled' : 'Disabled'}
          </span>
          <input type="checkbox" checked={model.is_active} disabled={toggling} onChange={handleToggle} />
        </label>
      </div>

      <div style={{ overflowX: 'auto', marginBottom: 'var(--space-4-5)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-base)' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.7 }}>
              <th style={{ padding: 'var(--space-1-5) var(--space-2-5)' }}>Phase</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Profit Target %</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Trailing Max DD %</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Daily Loss %</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Min Trading Days</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Time Limit (days)</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Consistency %</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}></th>
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
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-base)' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.7 }}>
              <th style={{ padding: 'var(--space-1-5) var(--space-2-5)' }}>Account Size</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Price (USD)</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Status</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Slots</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Slot Limit</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}>Usage</th>
              <th style={{ padding: 'var(--space-1-5) var(--space-2)' }}></th>
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

      <ScalingSection model={model} onSave={handleSaveScaling} saving={savingScaling} />
    </Card>
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

  async function handleSaveScaling(slug, draft) {
    try {
      await adminAxios.patch(`/api/admin/step-models/${slug}/scaling`, draft)
      toast.success('Scaling plan saved')
      loadModels()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not save scaling plan')
    }
  }

  if (loading) {
    return <div style={{ padding: 'var(--space-7)', opacity: 0.7 }}>Loading challenge models...</div>
  }

  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <h2 style={{ margin: '0 0 var(--space-1)' }}>Challenge Models</h2>
        <p style={{ margin: 0, opacity: 0.7, fontSize: 'var(--fs-base)' }}>
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
          onSaveScaling={handleSaveScaling}
        />
      ))}
    </div>
  )
}
