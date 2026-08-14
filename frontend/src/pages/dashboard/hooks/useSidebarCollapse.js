import { useState } from 'react'

// Sidebar collapsed state, persisted so it survives a reload.
export default function useSidebarCollapse() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebarCollapsed') === 'true' } catch { return false }
  })

  const handleToggleSidebar = () => setSidebarCollapsed(prev => {
    const next = !prev
    try { localStorage.setItem('sidebarCollapsed', String(next)) } catch {}
    return next
  })

  return { sidebarCollapsed, handleToggleSidebar }
}
