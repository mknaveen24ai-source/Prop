import React, { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../ThemeContext'
import { Headset, ChevronLeft, ChevronRight, ChevronDown, MoreHorizontal } from 'lucide-react'
import { renderIcon } from '../utils/iconMap'
import BottomSheet from './ui/BottomSheet'

// Mobile bottom bar shows these 4 first, plus a persistent "More" tab and
// the Profile tab — everything else (Compare, Competitions, Rules, New
// Challenge, KYC, Payouts, Affiliate, Live Chat, Appeal, Support, Public
// Site) lives in the More sheet instead of a 15-wide scrollable row.
const MOBILE_PRIMARY_IDS = ['dashboard', 'trade', 'analytics', 'history']

// Grouped nav (Modern Gazette handoff spec: "grouped, collapsible sections
// — Desk, Programme, Account, Help, Reference"), mirroring AdminSidebar's
// NavGroup pattern on the trader side.
const NAV_GROUPS = [
  {
    id: 'desk',
    label: 'Desk',
    items: [
      { id: 'dashboard', icon: 'dashboard', label: 'Dashboard' },
      { id: 'trade', icon: 'trade', label: 'Trade' },
      { id: 'analytics', icon: 'analytics', label: 'Analytics' },
      // Not in the Modern Gazette handoff spec's 26-screen prototype — real
      // product functionality, appended last so it doesn't reorder the
      // spec'd items (same rationale as "New Challenge" below).
      { id: 'compare', icon: 'analytics', label: 'Compare Accounts' },
    ],
  },
  {
    id: 'programme',
    label: 'Programme',
    items: [
      // Order matches the prototype's NAV.trader Programme group exactly
      // (Competitions, Rules, History). "New Challenge" isn't in the
      // prototype's nav — real product functionality outside the 26-screen
      // spec, kept but placed after the spec'd items so it doesn't reorder
      // them (Modern Gazette handoff spec ground truth, see plan).
      { id: 'competitions', icon: 'leaderboard', label: 'Competitions' },
      { id: 'rules', icon: 'journal', label: 'Rules' },
      { id: 'history', icon: 'history', label: 'History' },
      { id: 'get-challenge', icon: 'target', label: 'New Challenge' },
    ],
  },
  {
    id: 'account',
    label: 'Account',
    items: [
      { id: 'kyc', icon: 'kyc', label: 'KYC' },
      { id: 'payouts', icon: 'payouts', label: 'Payouts' },
      { id: 'affiliate', icon: 'affiliate', label: 'Affiliate' },
      { id: 'certificates', icon: 'leaderboard', label: 'Certificates' },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [
      { id: 'chat', icon: 'chat', label: 'Live Chat' },
      { id: 'dispute', icon: 'dispute', label: 'Appeal' },
      { id: 'support', icon: 'support', label: 'Support' },
    ],
  },
  {
    id: 'reference',
    label: 'Reference',
    items: [
      // Prototype's Reference group also has a "Handoff Spec" item (the
      // design doc rendered live inside the prototype) — no real-app
      // equivalent, omitted rather than repointed (decided). New tab so a
      // logged-in trader actually sees the marketing site instead of "/"
      // redirecting them straight back to /dashboard.
      { id: 'landing', icon: 'globe', label: 'Public Site', externalPath: '/', openInNewTab: true },
    ],
  },
]
const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items)

export { NAV_GROUPS }

const NAV_GROUP_STORAGE_KEY = 'trader-nav-collapsed-groups'

function loadCollapsedGroups() {
  try {
    return JSON.parse(localStorage.getItem(NAV_GROUP_STORAGE_KEY)) || {}
  } catch {
    return {}
  }
}

export default function Sidebar({
  user,
  activePage,
  setActivePage,
  kycStatus,
  pendingPayouts = 0,
  unreadNotifications = 0,
  onLogout,
  collapsed = false,
  onToggleCollapse,
}) {
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [collapsedGroups, setCollapsedGroups] = useState(loadCollapsedGroups)
  // Escape handling, focus trap and scroll lock now come from BottomSheet.
  const [showMoreSheet, setShowMoreSheet] = useState(false)

  const mobilePrimaryItems = NAV_ITEMS.filter((item) => MOBILE_PRIMARY_IDS.includes(item.id))
  const mobileOverflowGroups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => !MOBILE_PRIMARY_IDS.includes(item.id)) }))
    .filter((group) => group.items.length > 0)
  const kycNeedsAttention = kycStatus === 'pending' || kycStatus === 'not_submitted' || kycStatus === 'rejected'
  const hasOverflowAlert = kycNeedsAttention || pendingPayouts > 0

  function toggleGroup(id) {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      try {
        localStorage.setItem(NAV_GROUP_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // ignore storage failures (private browsing, quota, etc.)
      }
      return next
    })
  }

  function handleNavClick(item) {
    if (item.openInNewTab) {
      window.open(item.externalPath, '_blank', 'noopener')
      return
    }
    if (item.externalPath) {
      navigate(item.externalPath)
      return
    }
    setActivePage(item.id)
  }

  const displayName = user?.full_name || 'Trader'
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'TR'

  const sidebarWidth = collapsed ? '64px' : '220px'

  function renderNavItem(item) {
    const isActive = activePage === item.id

    // Badge count for this item
    let badge = null
    if (item.id === 'kyc' && (kycStatus === 'pending' || kycStatus === 'not_submitted' || kycStatus === 'rejected')) {
      badge = (
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          background: kycStatus === 'pending' ? 'var(--warning)' : 'var(--danger)',
          flexShrink: 0, boxShadow: kycStatus === 'pending' ? '0 0 8px var(--warning)' : '0 0 8px var(--danger)',
          marginLeft: collapsed ? 0 : 'auto',
          position: collapsed ? 'absolute' : 'static',
          top: collapsed ? '4px' : undefined,
          right: collapsed ? '4px' : undefined,
        }} />
      )
    }
    if (item.id === 'payouts' && pendingPayouts > 0) {
      badge = (
        <span className="badge badge-danger" style={{
          marginLeft: collapsed ? 0 : 'auto', flexShrink: 0,
          padding: '2px 6px', fontSize: 'var(--fs-2xs)', borderRadius: 'var(--radius-pill)',
          position: collapsed ? 'absolute' : 'static',
          top: collapsed ? '2px' : undefined, right: collapsed ? '2px' : undefined,
        }}>
          {pendingPayouts}
        </span>
      )
    }
    if (item.id === 'dashboard' && unreadNotifications > 0) {
      badge = (
        <span className="badge badge-danger" style={{
          marginLeft: collapsed ? 0 : 'auto', flexShrink: 0,
          padding: '2px 6px', fontSize: 'var(--fs-2xs)', borderRadius: 'var(--radius-pill)',
          position: collapsed ? 'absolute' : 'static',
          top: collapsed ? '2px' : undefined, right: collapsed ? '2px' : undefined,
        }}>
          {unreadNotifications}
        </span>
      )
    }

    return (
      <motion.div
        key={item.id}
        whileHover={{ x: collapsed ? 0 : 3 }}
        transition={{ duration: 0.15 }}
        style={{ position: 'relative' }}
      >
        <button
          onClick={() => handleNavClick(item)}
          title={collapsed ? item.label : undefined}
          className={`sidebar-item ${isActive ? 'active' : ''}`}
          style={{
            width: '100%',
            textAlign: 'left',
            justifyContent: collapsed ? 'center' : 'flex-start',
            padding: collapsed ? '8px 0' : undefined,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, opacity: 0.9 }}>
            {item.id === 'support'
              ? <Headset size={15} color={isActive ? 'var(--accent)' : 'var(--muted)'} />
              : renderIcon(item.icon, { size: 15, color: isActive ? 'var(--accent)' : 'var(--muted)' })}
          </span>

          <AnimatePresence>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.2 }}
                style={{ overflow: 'hidden', whiteSpace: 'nowrap', flex: 1 }}
              >
                {item.label}
              </motion.span>
            )}
          </AnimatePresence>

          {!collapsed && badge}
        </button>

        {/* In collapsed mode, show badge outside the button */}
        {collapsed && badge}
      </motion.div>
    )
  }

  return (
    <>
      <div
        className="sidebar"
        style={{
          background: 'var(--glass)',
          backdropFilter: 'blur(20px) saturate(140%)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
          borderRight: '1px solid var(--rule-soft)',
          width: sidebarWidth,
          minWidth: sidebarWidth,
          transition: 'width 0.25s cubic-bezier(0.4,0,0.2,1)',
          overflowX: 'hidden',
        }}
      >
        {/* Header */}
        <div
          className="sidebar-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: collapsed ? '24px 14px' : '24px 20px',
            borderBottom: '1px solid var(--border)',
            justifyContent: collapsed ? 'center' : 'flex-start',
            transition: 'padding 0.25s',
          }}
        >
          <div
            style={{
              width: '36px',
              height: '36px',
              flexShrink: 0,
              background: 'linear-gradient(135deg, var(--accent), var(--info))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--paper)',
              fontSize: 'var(--fs-xl)',
              boxShadow: '0 4px 12px var(--accent-glow)',
            }}
          >
            ⚡
          </div>
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.2 }}
                style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}
              >
                <div style={{ fontSize: '15px', fontWeight: 800, letterSpacing: '0.02em', color: 'var(--text-primary)' }}>
                  PROP FIRM
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>Trader Portal</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>


        {/* Navigation */}
        <nav className="sidebar-nav" style={{ padding: collapsed ? '16px 8px' : '24px 12px', transition: 'padding 0.25s' }}>
          {NAV_GROUPS.map((group) => {
            const isGroupCollapsed = !collapsed && !!collapsedGroups[group.id]
            return (
              <div key={group.id} style={{ marginBottom: '14px' }}>
                <AnimatePresence>
                  {!collapsed && (
                    <motion.button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      aria-expanded={!isGroupCollapsed}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 'var(--fs-xs)', fontWeight: 700, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.1em',
                        marginBottom: 'var(--space-2)', padding: '0 12px',
                      }}
                    >
                      <span style={{ flex: 1, textAlign: 'left' }}>{group.label}</span>
                      <ChevronDown
                        size={12}
                        style={{
                          transform: isGroupCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                          transition: 'transform 0.18s',
                          flexShrink: 0,
                        }}
                      />
                    </motion.button>
                  )}
                </AnimatePresence>
                {!isGroupCollapsed && group.items.map(renderNavItem)}
              </div>
            )
          })}
        </nav>


        {/* Footer — theme toggle + profile (click through to Profile tab) */}
        <div className="sidebar-footer" style={{ borderTop: '1px solid var(--border)', padding: collapsed ? '16px 8px' : '20px 16px', transition: 'padding 0.25s', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {!collapsed && (
            <div style={{ display: 'flex', gap: '6px', padding: '3px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper)' }}>
              <button
                type="button"
                onClick={() => theme !== 'dark' && toggleTheme()}
                style={{
                  flex: 1, padding: '6px 0', border: 'none', borderRadius: '3px', cursor: 'pointer',
                  fontFamily: 'var(--font-mono)', fontSize: '10.5px', letterSpacing: '.08em', textTransform: 'uppercase',
                  background: theme === 'dark' ? 'var(--accent)' : 'transparent',
                  color: theme === 'dark' ? 'var(--paper)' : 'var(--muted)',
                }}
              >
                Night
              </button>
              <button
                type="button"
                onClick={() => theme !== 'light' && toggleTheme()}
                style={{
                  flex: 1, padding: '6px 0', border: 'none', borderRadius: '3px', cursor: 'pointer',
                  fontFamily: 'var(--font-mono)', fontSize: '10.5px', letterSpacing: '.08em', textTransform: 'uppercase',
                  background: theme === 'light' ? 'var(--accent)' : 'transparent',
                  color: theme === 'light' ? 'var(--paper)' : 'var(--muted)',
                }}
              >
                Day
              </button>
              {onLogout && (
                <button
                  type="button"
                  onClick={onLogout}
                  title="Log out"
                  style={{ padding: '6px 9px', border: 'none', borderRadius: '3px', cursor: 'pointer', background: 'transparent', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center' }}
                >
                  {renderIcon('logout', { size: 13, color: 'currentColor' })}
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => setActivePage('profile')}
            title="View profile"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              width: '100%',
              padding: collapsed ? '8px' : '10px 12px',
              background: activePage === 'profile' ? 'var(--accent-glow)' : 'var(--bg-hover)',
              cursor: 'pointer',
              border: activePage === 'profile' ? '1px solid var(--accent)' : '1px solid var(--border-strong)',
              justifyContent: collapsed ? 'center' : 'flex-start',
              transition: 'background 0.15s, border-color 0.15s',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => { if (activePage !== 'profile') e.currentTarget.style.background = 'var(--accent-glow)' }}
            onMouseLeave={(e) => { if (activePage !== 'profile') e.currentTarget.style.background = 'var(--bg-hover)' }}
          >
            <div style={{
              width: '32px', height: '32px', flexShrink: 0,
              borderRadius: '50%', background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--paper)', fontSize: 'var(--fs-sm)', fontWeight: 600,
            }}>
              {initials}
            </div>
            <AnimatePresence>
              {!collapsed && (
                <motion.div
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 'auto' }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}
                >
                  <div style={{ fontSize: 'var(--fs-base)', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {displayName}
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--success)' }}>• Active</div>
                </motion.div>
              )}
            </AnimatePresence>
          </button>
        </div>
      </div>

      {/* Collapse toggle — a sibling of .sidebar, not a child, so it isn't
          clipped by the sidebar's own overflow-x:hidden (needed for the
          collapse-width transition). position:fixed + left tracks the
          sidebar's own dynamic width instead of using right:-Npx relative
          to a box that clips anything sitting outside it. */}
      {onToggleCollapse && (
        <button
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            position: 'fixed',
            top: '72px',
            left: `calc(${sidebarWidth} - 12px)`,
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            background: 'var(--paper-2)',
            border: '1px solid var(--rule)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 101,
            color: 'var(--muted)',
            transition: 'left 0.25s cubic-bezier(0.4,0,0.2,1), background 0.15s, color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = 'var(--paper)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--paper-2)'; e.currentTarget.style.color = 'var(--muted)' }}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>
      )}

      {/* Mobile bottom nav — 4 primary tabs + More (everything else) + Profile,
          instead of all ~15 items in a horizontally-scrollable row. */}
      <nav className="sidebar-mobile-bottom">
        {mobilePrimaryItems.map(item => {
          const isActive = activePage === item.id
          return (
            <button
              key={item.id}
              onClick={() => handleNavClick(item)}
              className="mobile-tab-btn"
              style={{
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                borderTop: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'transparent',
              }}
            >
              <span style={{ position: 'relative', display: 'inline-block' }}>
                <span style={{ display: 'inline-flex', lineHeight: 1 }}>
                  {item.id === 'support'
                    ? <Headset size={18} color={isActive ? 'var(--accent)' : 'var(--text-muted)'} />
                    : renderIcon(item.icon, { size: 18, color: isActive ? 'var(--accent)' : 'var(--text-muted)' })}
                </span>
                {item.id === 'kyc' && (kycStatus === 'pending' || kycStatus === 'not_submitted' || kycStatus === 'rejected') && (
                  <span style={{
                    position: 'absolute', top: '-3px', right: '-5px',
                    width: '7px', height: '7px', borderRadius: '50%',
                    background: kycStatus === 'pending' ? 'var(--accent)' : 'var(--red)',
                    border: '1px solid var(--navy)'
                  }} />
                )}
                {item.id === 'payouts' && pendingPayouts > 0 && (
                  <span style={{
                    position: 'absolute', top: '-4px', right: '-8px',
                    background: 'var(--accent)', color: 'var(--navy)',
                    borderRadius: 'var(--radius-pill)', fontSize: 'var(--fs-3xs)', fontWeight: '700',
                    padding: '0 4px', lineHeight: '14px', minWidth: '14px',
                    textAlign: 'center'
                  }}>
                    {pendingPayouts}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 'var(--fs-2xs)', fontWeight: isActive ? '600' : '400', marginTop: '3px' }}>
                {item.label}
              </span>
            </button>
          )
        })}

        {/* More — opens a sheet with everything not in mobilePrimaryItems */}
        <button
          onClick={() => setShowMoreSheet(true)}
          className="mobile-tab-btn"
          aria-haspopup="dialog"
          aria-expanded={showMoreSheet}
          style={{
            color: showMoreSheet ? 'var(--accent)' : 'var(--text-muted)',
            borderTop: showMoreSheet ? '2px solid var(--accent)' : '2px solid transparent',
            background: 'transparent',
          }}
        >
          <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 1 }}>
            <MoreHorizontal size={18} color={showMoreSheet ? 'var(--accent)' : 'var(--text-muted)'} />
            {hasOverflowAlert && (
              <span style={{
                position: 'absolute', top: '-3px', right: '-5px',
                width: '7px', height: '7px', borderRadius: '50%',
                background: 'var(--red)', border: '1px solid var(--navy)'
              }} />
            )}
          </span>
          <span style={{ fontSize: 'var(--fs-2xs)', fontWeight: showMoreSheet ? '600' : '400', marginTop: '3px' }}>
            More
          </span>
        </button>

        {/* Profile — mobile-only entry point (desktop reaches it via the
            sidebar footer avatar instead, so it's intentionally not in
            NAV_ITEMS/the desktop list). */}
        <button
          onClick={() => setActivePage('profile')}
          className="mobile-tab-btn"
          style={{
            color: activePage === 'profile' ? 'var(--accent)' : 'var(--text-muted)',
            borderTop: activePage === 'profile' ? '2px solid var(--accent)' : '2px solid transparent',
            background: 'transparent',
          }}
        >
          <span style={{ display: 'inline-flex', lineHeight: 1 }}>
            {renderIcon('profile', { size: 18, color: activePage === 'profile' ? 'var(--accent)' : 'var(--text-muted)' })}
          </span>
          <span style={{ fontSize: 'var(--fs-2xs)', fontWeight: activePage === 'profile' ? '600' : '400', marginTop: '3px' }}>
            Profile
          </span>
        </button>
      </nav>

      {/* Mobile "More" sheet — everything not promoted to a primary tab.
          Behaviour (focus trap, Escape, scrim, body scroll lock) lives in the
          shared ui/BottomSheet primitive; this file only supplies the list. */}
      <BottomSheet
        open={showMoreSheet}
        onClose={() => setShowMoreSheet(false)}
        title="More"
        padded={false}
      >
        {mobileOverflowGroups.map((group) => (
          <div key={group.id} className="sidebar-more-group">
            <div className="sidebar-more-group__label">{group.label}</div>
            {group.items.map((item) => {
              const isActive = activePage === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => { handleNavClick(item); setShowMoreSheet(false) }}
                  className="sidebar-more-item"
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="sidebar-more-item__icon">
                    {item.id === 'support'
                      ? <Headset size={17} color={isActive ? 'var(--accent)' : 'var(--muted)'} />
                      : renderIcon(item.icon, { size: 17, color: isActive ? 'var(--accent)' : 'var(--muted)' })}
                    {item.id === 'kyc' && kycNeedsAttention && (
                      <span
                        className="sidebar-more-item__dot"
                        style={{ background: kycStatus === 'pending' ? 'var(--warning)' : 'var(--danger)' }}
                      />
                    )}
                  </span>
                  <span className="sidebar-more-item__label">{item.label}</span>
                  {item.id === 'payouts' && pendingPayouts > 0 && (
                    <span className="badge badge-danger" style={{ padding: '2px 6px', fontSize: 'var(--fs-2xs)', borderRadius: 'var(--radius-pill)' }}>
                      {pendingPayouts}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </BottomSheet>
    </>
  )
}
