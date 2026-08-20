import React, { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import Card from '../../components/ui/Card'

const STATUS_COLORS = {
  issued: 'var(--admin-text-muted)',
  claimed: 'var(--admin-accent-positive, #2ecc71)',
  expired: 'var(--admin-text-faint)',
  revoked: 'var(--admin-accent-negative, #e74c3c)'
}

export default function AdminGifts() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()

  const [loading, setLoading] = useState(true)
  const [gifts, setGifts] = useState([])
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [revokingId, setRevokingId] = useState(null)

  const loadGifts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/gift-vouchers', {
        params: { status: status || undefined, search: search || undefined }
      })
      setGifts(Array.isArray(res.data?.gifts) ? res.data.gifts : [])
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not load gift vouchers')
    } finally {
      setLoading(false)
    }
  }, [adminAxios, toast, status, search])

  useEffect(() => {
    const t = setTimeout(loadGifts, 300)
    return () => clearTimeout(t)
  }, [loadGifts])

  const handleRevoke = async (id) => {
    if (!window.confirm('Revoke this gift? The recipient will no longer be able to claim it.')) return
    setRevokingId(id)
    try {
      await adminAxios.post(`/api/admin/gift-vouchers/${id}/revoke`)
      setGifts(current => current.map(g => (g.id === id ? { ...g, status: 'revoked' } : g)))
      toast.success('Gift revoked')
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not revoke this gift')
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 className="admin-h1">Gift Vouchers</h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
          Challenge accounts purchased as gifts. Buyers create these at checkout — this view is for
          monitoring and support (revoking an unclaimed gift), not creation.
        </p>
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <select className="admin-select" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All statuses</option>
            <option value="issued">Issued (unclaimed)</option>
            <option value="claimed">Claimed</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>
          <input
            className="admin-input"
            style={{ flex: 1, minWidth: 200 }}
            placeholder="Search by email or code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="admin-skeleton" style={{ height: '200px' }} />
        ) : gifts.length === 0 ? (
          <div style={{ color: 'var(--admin-text-muted)', fontSize: 13 }}>No gift vouchers found.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table" style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 'var(--space-2)' }}>Code</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-2)' }}>Status</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-2)' }}>Size</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-2)' }}>Purchaser</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-2)' }}>Recipient</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-2)' }}>Issued</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-2)' }}>Expires</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-2)' }}></th>
                </tr>
              </thead>
              <tbody>
                {gifts.map((gift) => (
                  <tr key={gift.id} style={{ borderTop: '1px solid var(--admin-border)' }}>
                    <td style={{ padding: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>{gift.code}</td>
                    <td style={{ padding: 'var(--space-2)', color: STATUS_COLORS[gift.status] || 'var(--admin-text)' }}>{gift.status}</td>
                    <td style={{ padding: 'var(--space-2)' }}>${Number(gift.account_size).toLocaleString()}</td>
                    <td style={{ padding: 'var(--space-2)' }}>{gift.purchaser_email || '—'}</td>
                    <td style={{ padding: 'var(--space-2)' }}>{gift.recipient_email}</td>
                    <td style={{ padding: 'var(--space-2)' }}>{gift.issued_at ? new Date(gift.issued_at).toLocaleDateString() : '—'}</td>
                    <td style={{ padding: 'var(--space-2)' }}>{gift.expires_at ? new Date(gift.expires_at).toLocaleDateString() : '—'}</td>
                    <td style={{ padding: 'var(--space-2)' }}>
                      {gift.status === 'issued' && (
                        <button
                          className="admin-btn admin-btn-ghost"
                          disabled={revokingId === gift.id}
                          onClick={() => handleRevoke(gift.id)}
                        >
                          {revokingId === gift.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
