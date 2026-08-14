import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { API_BASE_URL as API_URL } from '../../../config/apiBase'

export const announcementKey = (a) => a ? `${a.message}|${a.updated_at}` : null

// Platform announcement banner: fetched on mount and re-polled every 5 minutes.
export default function useAnnouncement() {
  const [announcement, setAnnouncement] = useState(null)
  const [announcementDismissed, setAnnouncementDismissed] = useState(false)
  const dismissedAnnouncementKeyRef = useRef(null)

  useEffect(() => {
    // Fetch on mount
    axios.get(`${API_URL}/api/announcement`)
      .then(res => { if (res.data) setAnnouncement(res.data) })
      .catch(() => {})
    // Re-poll every 5 minutes
    const iv = setInterval(() => {
      axios.get(`${API_URL}/api/announcement`)
        .then(res => {
          setAnnouncement(res.data || null)
          // Reset dismissal when the announcement disappears OR changes to
          // different content — a dismissed banner shouldn't stay hidden
          // forever once an admin posts a new one.
          if (announcementKey(res.data) !== dismissedAnnouncementKeyRef.current) {
            setAnnouncementDismissed(false)
          }
        })
        .catch(() => {})
    }, 5 * 60 * 1000)
    return () => clearInterval(iv)
  }, [])

  function dismissAnnouncement() {
    dismissedAnnouncementKeyRef.current = announcementKey(announcement)
    setAnnouncementDismissed(true)
  }

  return { announcement, announcementDismissed, dismissAnnouncement }
}
