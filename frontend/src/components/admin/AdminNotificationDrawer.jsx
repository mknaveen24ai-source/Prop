import React, { useEffect, useMemo, useState } from 'react'
import { renderIcon } from '../../utils/iconMap'

// Alerts are derived live from violation/KYC/payout counts (no backend
// notification records), so there's no server-side id to key read-state on.
// A content signature is good enough for "have I seen this" tracking.
const READ_STORAGE_KEY = 'propfirm:admin:notifications:read'

function alertId(alert) {
  return `${alert.kicker}::${alert.text}`
}

function loadReadIds() {
  try {
    const raw = localStorage.getItem(READ_STORAGE_KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch {
    return new Set()
  }
}

function saveReadIds(ids) {
  try {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Private browsing / quota exceeded — read state just won't persist.
  }
}

export default function AdminNotificationDrawer({ open, onClose, alerts, onNavigate }) {
  const [readIds, setReadIds] = useState(loadReadIds)

  useEffect(() => {
    if (!open) return undefined
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  function markRead(id) {
    setReadIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      saveReadIds(next)
      return next
    })
  }

  function markAllRead() {
    setReadIds((prev) => {
      const next = new Set(prev)
      alerts.forEach((alert) => next.add(alertId(alert)))
      saveReadIds(next)
      return next
    })
  }

  const unreadCount = useMemo(
    () => alerts.filter((alert) => !readIds.has(alertId(alert))).length,
    [alerts, readIds]
  )

  return (
    <>
      <div
        className={`admin-notif-drawer-backdrop${open ? ' is-open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={`admin-notif-drawer${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <div className="admin-notif-drawer-header">
          <strong style={{ fontSize: 'var(--fs-md)' }}>Alerts</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3-5)' }}>
            {unreadCount > 0 && (
              <button type="button" className="admin-notif-drawer-mark-all" onClick={markAllRead}>
                Mark all read
              </button>
            )}
            <button type="button" className="admin-icon-btn" onClick={onClose} aria-label="Close alerts">
              {renderIcon('close', { size: 14, color: 'var(--admin-text)' })}
            </button>
          </div>
        </div>

        <div className="admin-notif-drawer-body">
          {alerts.length === 0 ? (
            <div className="admin-empty-state" style={{ padding: 'var(--space-7) var(--space-4)' }}>
              Nothing yet.
            </div>
          ) : (
            alerts.map((alert) => {
              const id = alertId(alert)
              const isUnread = !readIds.has(id)
              return (
                <button
                  type="button"
                  key={id}
                  className="admin-notif-drawer-item"
                  onClick={() => {
                    markRead(id)
                    onNavigate?.(alert)
                  }}
                >
                  <span className={`admin-notif-drawer-dot${isUnread ? ' is-unread' : ''}`} aria-hidden="true" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="admin-notif-drawer-kicker" style={{ color: `var(--${alert.tone})` }}>
                      {alert.kicker}
                    </div>
                    <div className="admin-notif-drawer-text">{alert.text}</div>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </aside>
    </>
  )
}
