import React, { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import Card from '../../components/ui/Card'

/**
 * AdminCoupons — checkout discount code management. Not one of the 26
 * prototype screens (the prototype's Settings screen is a generic
 * toggle/value-row pattern that doesn't fit a coupon CRUD table), so this
 * was relocated out of AdminSettings.jsx into its own screen/route rather
 * than force-fit into that pattern (explicit user decision).
 */
export default function AdminCoupons() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()

  const [loading, setLoading] = useState(true)
  const [coupons, setCoupons] = useState([])
  const [couponDrafts, setCouponDrafts] = useState({})
  const [couponSavingId, setCouponSavingId] = useState(null)
  const [couponDeletingId, setCouponDeletingId] = useState(null)
  const [newCoupon, setNewCoupon] = useState({
    code: '', description: '', discount_type: 'percent', discount_value: '',
    max_redemptions: '', min_order_amount: '', expires_at: ''
  })
  const [creatingCoupon, setCreatingCoupon] = useState(false)

  const loadCoupons = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/coupons')
      const rows = Array.isArray(res.data?.coupons) ? res.data.coupons : []
      setCoupons(rows)
      setCouponDrafts(rows.reduce((acc, c) => {
        acc[c.id] = {
          discount_value: String(c.discount_value),
          max_redemptions: c.max_redemptions != null ? String(c.max_redemptions) : '',
          min_order_amount: c.min_order_amount != null ? String(c.min_order_amount) : '',
          expires_at: c.expires_at ? String(c.expires_at).slice(0, 10) : '',
          is_active: c.is_active
        }
        return acc
      }, {}))
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not load coupons')
    } finally {
      setLoading(false)
    }
  }, [adminAxios, toast])

  useEffect(() => {
    loadCoupons()
  }, [loadCoupons])

  const updateCouponDraft = (id, patch) => {
    setCouponDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } }))
  }

  const handleSaveCoupon = async (id) => {
    const draft = couponDrafts[id]
    if (!draft) return
    setCouponSavingId(id)
    try {
      const res = await adminAxios.patch(`/api/admin/coupons/${id}`, {
        discount_value: Number(draft.discount_value),
        max_redemptions: draft.max_redemptions === '' ? null : Number(draft.max_redemptions),
        min_order_amount: draft.min_order_amount === '' ? null : Number(draft.min_order_amount),
        expires_at: draft.expires_at || null,
        is_active: draft.is_active
      })
      setCoupons(current => current.map(c => (c.id === id ? res.data : c)))
      toast.success('Coupon updated')
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not update coupon')
    } finally {
      setCouponSavingId(null)
    }
  }

  const handleDeleteCoupon = async (id) => {
    if (!window.confirm('Delete this coupon? This cannot be undone.')) return
    setCouponDeletingId(id)
    try {
      await adminAxios.delete(`/api/admin/coupons/${id}`)
      setCoupons(current => current.filter(c => c.id !== id))
      toast.success('Coupon deleted')
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not delete coupon')
    } finally {
      setCouponDeletingId(null)
    }
  }

  const handleCreateCoupon = async () => {
    setCreatingCoupon(true)
    try {
      const res = await adminAxios.post('/api/admin/coupons', {
        code: newCoupon.code,
        description: newCoupon.description,
        discount_type: newCoupon.discount_type,
        discount_value: Number(newCoupon.discount_value),
        max_redemptions: newCoupon.max_redemptions === '' ? null : Number(newCoupon.max_redemptions),
        min_order_amount: newCoupon.min_order_amount === '' ? null : Number(newCoupon.min_order_amount),
        expires_at: newCoupon.expires_at || null
      })
      const created = res.data
      setCoupons(current => [created, ...current])
      setCouponDrafts(current => ({
        ...current,
        [created.id]: {
          discount_value: String(created.discount_value),
          max_redemptions: created.max_redemptions != null ? String(created.max_redemptions) : '',
          min_order_amount: created.min_order_amount != null ? String(created.min_order_amount) : '',
          expires_at: created.expires_at ? String(created.expires_at).slice(0, 10) : '',
          is_active: created.is_active
        }
      }))
      setNewCoupon({ code: '', description: '', discount_type: 'percent', discount_value: '', max_redemptions: '', min_order_amount: '', expires_at: '' })
      toast.success('Coupon created')
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not create coupon')
    } finally {
      setCreatingCoupon(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-8)', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--space-3-5)' }}>
        {Array(4).fill(0).map((_, index) => (
          <div key={index} className="admin-skeleton" style={{ height: '200px' }} />
        ))}
      </div>
    )
  }

  return (
    <>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 className="admin-h1">Coupons</h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
          Codes traders can enter at checkout for a percent or fixed-dollar discount. Each code can only be
          redeemed once per trader, and stacks on top of any active referral discount.
        </p>
      </div>

      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 18 }}>
          {coupons.map((coupon) => {
            const draft = couponDrafts[coupon.id] || { discount_value: '', max_redemptions: '', min_order_amount: '', expires_at: '', is_active: true }
            const savingThis = couponSavingId === coupon.id
            const deletingThis = couponDeletingId === coupon.id
            return (
              <div key={coupon.id} style={{ border: '1px solid var(--admin-border)', borderRadius: 14, padding: 14, background: 'var(--admin-bg-elevated)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <span style={{ color: 'var(--admin-text)', fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 15 }}>{coupon.code}</span>
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: 11, marginTop: 2 }}>
                      {coupon.redemption_count} used{coupon.max_redemptions != null ? ` / ${coupon.max_redemptions}` : ''}
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--admin-text-muted)' }}>
                    <input type="checkbox" checked={!!draft.is_active} onChange={(e) => updateCouponDraft(coupon.id, { is_active: e.target.checked })} />
                    Active
                  </label>
                </div>
                {coupon.description && (
                  <div style={{ color: 'var(--admin-text-muted)', fontSize: 12, marginBottom: 10 }}>{coupon.description}</div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                  <div className="admin-form-group" style={{ marginBottom: 0 }}>
                    <label className="admin-label">{coupon.discount_type === 'percent' ? 'Discount %' : 'Discount $'}</label>
                    <input className="admin-input" type="number" min="0" step="0.01" value={draft.discount_value} onChange={(e) => updateCouponDraft(coupon.id, { discount_value: e.target.value })} />
                  </div>
                  <div className="admin-form-group" style={{ marginBottom: 0 }}>
                    <label className="admin-label">Max Redemptions</label>
                    <input className="admin-input" type="number" min="1" placeholder="Unlimited" value={draft.max_redemptions} onChange={(e) => updateCouponDraft(coupon.id, { max_redemptions: e.target.value })} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div className="admin-form-group" style={{ marginBottom: 0 }}>
                    <label className="admin-label">Min Order ($)</label>
                    <input className="admin-input" type="number" min="0" placeholder="None" value={draft.min_order_amount} onChange={(e) => updateCouponDraft(coupon.id, { min_order_amount: e.target.value })} />
                  </div>
                  <div className="admin-form-group" style={{ marginBottom: 0 }}>
                    <label className="admin-label">Expires</label>
                    <input className="admin-input" type="date" value={draft.expires_at} onChange={(e) => updateCouponDraft(coupon.id, { expires_at: e.target.value })} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="admin-btn admin-btn-primary" style={{ flex: 1 }} onClick={() => handleSaveCoupon(coupon.id)} disabled={savingThis || deletingThis}>
                    {savingThis ? 'Saving...' : 'Save'}
                  </button>
                  <button className="admin-btn admin-btn-ghost" onClick={() => handleDeleteCoupon(coupon.id)} disabled={savingThis || deletingThis}>
                    {deletingThis ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            )
          })}
          {coupons.length === 0 && (
            <div style={{ color: 'var(--admin-text-muted)', fontSize: 13 }}>No coupon codes yet — add one below.</div>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--admin-border)', paddingTop: 16 }}>
          <h3 className="admin-h3" style={{ marginBottom: 12 }}>Add New Coupon</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, alignItems: 'end', marginBottom: 10 }}>
            <div className="admin-form-group" style={{ marginBottom: 0 }}>
              <label className="admin-label">Code</label>
              <input className="admin-input" style={{ textTransform: 'uppercase' }} value={newCoupon.code} onChange={(e) => setNewCoupon(cur => ({ ...cur, code: e.target.value }))} placeholder="e.g. SAVE20" />
            </div>
            <div className="admin-form-group" style={{ marginBottom: 0 }}>
              <label className="admin-label">Type</label>
              <select className="admin-select" value={newCoupon.discount_type} onChange={(e) => setNewCoupon(cur => ({ ...cur, discount_type: e.target.value }))}>
                <option value="percent">Percent (%)</option>
                <option value="fixed">Fixed ($)</option>
              </select>
            </div>
            <div className="admin-form-group" style={{ marginBottom: 0 }}>
              <label className="admin-label">Discount Value</label>
              <input className="admin-input" type="number" min="0" step="0.01" value={newCoupon.discount_value} onChange={(e) => setNewCoupon(cur => ({ ...cur, discount_value: e.target.value }))} />
            </div>
            <div className="admin-form-group" style={{ marginBottom: 0 }}>
              <label className="admin-label">Max Redemptions</label>
              <input className="admin-input" type="number" min="1" placeholder="Unlimited" value={newCoupon.max_redemptions} onChange={(e) => setNewCoupon(cur => ({ ...cur, max_redemptions: e.target.value }))} />
            </div>
            <div className="admin-form-group" style={{ marginBottom: 0 }}>
              <label className="admin-label">Min Order ($)</label>
              <input className="admin-input" type="number" min="0" placeholder="None" value={newCoupon.min_order_amount} onChange={(e) => setNewCoupon(cur => ({ ...cur, min_order_amount: e.target.value }))} />
            </div>
            <div className="admin-form-group" style={{ marginBottom: 0 }}>
              <label className="admin-label">Expires</label>
              <input className="admin-input" type="date" value={newCoupon.expires_at} onChange={(e) => setNewCoupon(cur => ({ ...cur, expires_at: e.target.value }))} />
            </div>
          </div>
          <div className="admin-form-group" style={{ marginBottom: 10 }}>
            <label className="admin-label">Description (optional)</label>
            <input className="admin-input" value={newCoupon.description} onChange={(e) => setNewCoupon(cur => ({ ...cur, description: e.target.value }))} placeholder="Internal note, not shown to traders" />
          </div>
          <button
            className="admin-btn admin-btn-primary"
            onClick={handleCreateCoupon}
            disabled={creatingCoupon || !newCoupon.code || !newCoupon.discount_value}
          >
            {creatingCoupon ? 'Adding...' : 'Add Coupon'}
          </button>
        </div>
      </Card>
    </>
  )
}
