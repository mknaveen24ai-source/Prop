import { useEffect, useRef, useState } from 'react'
import { notificationsAPI } from '../../../services/api'
import { getPersistentItem, setPersistentItem, removePersistentItem } from '../../../utils/memoryStore'

// The notification bell: persisted local notifications merged with the server's
// admin broadcasts, plus the dropdown's open/close behaviour.
//
// pushNotification is returned because the socket handlers raise notifications
// for drawdown warnings, account updates and platform broadcasts.
export default function useNotifications() {
  const [notifications, setNotifications] = useState(() => {
    try { return JSON.parse(getPersistentItem('notifications') || '[]') } catch { return [] }
  })
  const [showNotifications, setShowNotifications] = useState(false)
  const notifRef = useRef(null)
  const notifButtonRef = useRef(null)

  useEffect(() => {
    if (!showNotifications) return
    function handleClickOutside(e) {
      if (notifRef.current && !notifRef.current.contains(e.target)) setShowNotifications(false)
    }
    function handleEscape(e) {
      if (e.key === 'Escape') {
        setShowNotifications(false)
        notifButtonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [showNotifications])

  // Seed with persisted history (currently: admin broadcasts) so the bell
  // survives a localStorage clear and syncs across devices/tabs — merged
  // with, not replacing, whatever's already local (live trade/account
  // events pushed via pushNotification() are still client-only).
  useEffect(() => {
    notificationsAPI.getMine()
      .then((res) => {
        const serverNotifs = (res.data || []).map((n) => ({
          id: `srv-${n.id}`,
          message: n.title ? `${n.title}: ${n.message}` : n.message,
          type: n.type,
          time: n.created_at,
          read: n.read,
        }))
        setNotifications((prev) => {
          const existingIds = new Set(prev.map((n) => n.id))
          const merged = [...prev, ...serverNotifs.filter((n) => !existingIds.has(n.id))]
          merged.sort((a, b) => new Date(b.time) - new Date(a.time))
          return merged.slice(0, 50)
        })
      })
      .catch(() => {})
  }, [])

  function pushNotification(message, type = 'info') {
    // FIX (MEDIUM #14): Use crypto.randomUUID() instead of Date.now() to prevent
    // ID collisions when two notifications arrive in the same millisecond.
    const notif = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      message,
      type,
      time: new Date().toISOString(),
      read: false
    }
    setNotifications(prev => {
      const updated = [notif, ...prev].slice(0, 50)
      setPersistentItem('notifications', JSON.stringify(updated))
      return updated
    })
  }

  function markAllRead() {
    setNotifications(prev => {
      const updated = prev.map(n => ({ ...n, read: true }))
      setPersistentItem('notifications', JSON.stringify(updated))
      return updated
    })
    notificationsAPI.markAllRead().catch(() => {})
  }

  function clearNotifications() {
    setNotifications([])
    removePersistentItem('notifications')
    notificationsAPI.clearAll().catch(() => {})
  }

  return {
    notifications,
    showNotifications,
    setShowNotifications,
    notifRef,
    notifButtonRef,
    pushNotification,
    markAllRead,
    clearNotifications
  }
}
