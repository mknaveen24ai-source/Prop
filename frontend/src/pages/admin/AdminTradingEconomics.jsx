import React, { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import Card from '../../components/ui/Card'

const TIER_LABELS = {
  challenge: 'Challenge',
  funded: 'Funded',
  competition: 'Competition'
}

function cloneTierMap(map) {
  const next = {}
  for (const tier of Object.keys(TIER_LABELS)) {
    next[tier] = { ...(map?.[tier] || {}) }
  }
  return next
}

export default function AdminTradingEconomics() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTier, setActiveTier] = useState('challenge')
  const [instruments, setInstruments] = useState([])
  const [defaultCommission, setDefaultCommission] = useState(0)
  const [defaultSlippage, setDefaultSlippage] = useState(0)
  const [commissionMap, setCommissionMap] = useState({})
  const [slippageMap, setSlippageMap] = useState({})

  const loadSettings = useCallback(() => {
    setLoading(true)
    adminAxios.get('/api/admin/trading-economics')
      .then((res) => {
        const data = res.data || {}
        setInstruments(Array.isArray(data.instruments) ? data.instruments : [])
        setDefaultCommission(data.default_commission_per_lot || 0)
        setDefaultSlippage(data.default_slippage_max_pips_adverse || 0)
        setCommissionMap(cloneTierMap(data.commission_per_lot))
        setSlippageMap(cloneTierMap(data.slippage_max_pips_adverse))
      })
      .catch((error) => toast.error(error?.response?.data?.error || 'Could not load trading economics settings'))
      .finally(() => setLoading(false))
  }, [adminAxios, toast])

  useEffect(() => {
    loadSettings()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateCommission = (instrument, value) => {
    setCommissionMap((current) => ({
      ...current,
      [activeTier]: { ...current[activeTier], [instrument]: value }
    }))
  }

  const updateSlippage = (instrument, value) => {
    setSlippageMap((current) => ({
      ...current,
      [activeTier]: { ...current[activeTier], [instrument]: value }
    }))
  }

  function toNumericMap(tierMap) {
    const cleaned = {}
    for (const [tier, instrumentMap] of Object.entries(tierMap)) {
      const rows = {}
      for (const [instrument, value] of Object.entries(instrumentMap || {})) {
        if (value === '' || value === null || value === undefined) continue
        const numeric = Number(value)
        if (Number.isFinite(numeric)) rows[instrument] = numeric
      }
      if (Object.keys(rows).length > 0) cleaned[tier] = rows
    }
    return cleaned
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload = {
        commission_per_lot: toNumericMap(commissionMap),
        slippage_max_pips_adverse: toNumericMap(slippageMap)
      }
      const res = await adminAxios.post('/api/admin/trading-economics', payload)
      setCommissionMap(cloneTierMap(res.data?.commission_per_lot))
      setSlippageMap(cloneTierMap(res.data?.slippage_max_pips_adverse))
      toast.success('Trading economics settings saved')
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not save trading economics settings')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-8)', display: 'grid', gap: 'var(--space-4)' }}>
        {Array(4).fill(0).map((_, index) => (
          <div key={index} className="admin-skeleton" style={{ height: '48px' }} />
        ))}
      </div>
    )
  }

  const rows = [{ symbol: '*', label: 'Default (all other symbols)' }, ...instruments.map((symbol) => ({ symbol, label: symbol }))]

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-7)' }}>
        <div>
          <h1 className="admin-h1">Trading Economics</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
            Per-symbol commission and execution slippage, configurable per account tier. Leave a field blank to fall back
            to the tier's "Default" row, then to the platform-wide default (${defaultCommission}/lot commission, {defaultSlippage} pips max adverse slippage).
            Changes take effect within 30 seconds.
          </p>
        </div>
        <button className="admin-btn admin-btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save All'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {Object.keys(TIER_LABELS).map((tier) => (
          <button
            key={tier}
            className={`admin-btn ${activeTier === tier ? 'admin-btn-primary' : 'admin-btn-ghost'}`}
            onClick={() => setActiveTier(tier)}
          >
            {TIER_LABELS[tier]}
          </button>
        ))}
      </div>

      <Card>
        <div style={{ overflowX: 'auto' }}>
          <table className="admin-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Commission ($/lot)</th>
                <th>Max Adverse Slippage (pips)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.symbol}>
                  <td>{row.label}</td>
                  <td>
                    <input
                      className="admin-input"
                      type="number"
                      min="0"
                      step="0.01"
                      style={{ width: 120 }}
                      value={commissionMap[activeTier]?.[row.symbol] ?? ''}
                      onChange={(e) => updateCommission(row.symbol, e.target.value)}
                      placeholder="—"
                    />
                  </td>
                  <td>
                    <input
                      className="admin-input"
                      type="number"
                      min="0"
                      step="0.1"
                      style={{ width: 120 }}
                      value={slippageMap[activeTier]?.[row.symbol] ?? ''}
                      onChange={(e) => updateSlippage(row.symbol, e.target.value)}
                      placeholder="—"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}
