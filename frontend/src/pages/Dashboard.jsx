import React, { Suspense, lazy, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import MarketStatusPill from '../components/MarketStatusPill'
import CommandPaletteTrigger from '../components/CommandPaletteTrigger'
import Sidebar, { NAV_GROUPS } from '../components/Sidebar'
import CommandPalette from '../components/CommandPalette'
import Card from '../components/ui/Card'
import DashboardHome from './DashboardHome'
import ChallengeRules from './ChallengeRules'
import Onboarding, { shouldShowOnboarding } from './Onboarding'
import Support from './Support'
import Dispute from './Dispute'
import Chat from './Chat'
import { useAuth } from '../providers/AuthProvider'
import { renderIcon } from '../utils/iconMap'
import { calculateRealizedProfit } from '../utils/finance'
import { getStatusColor } from '../utils/constants'
import DashboardKYCPage from './DashboardKYCPage'
import DashboardCompetitionsPage from './DashboardCompetitionsPage'
import DashboardProfilePage from './DashboardProfilePage'
import DashboardComparePage from './DashboardComparePage'
import GetChallenge from './GetChallenge'
import ErrorBoundary from '../ErrorBoundary'
import useStore from '../store/useStore'
import { API_BASE_URL as API_URL } from '../config/apiBase'

// State, effects and side-effecting actions live in these hooks. Dashboard
// itself is the shell: page chrome plus the view switch.
import useDashboardFeedback from './dashboard/hooks/useDashboardFeedback'
import useNotifications from './dashboard/hooks/useNotifications'
import useAnnouncement from './dashboard/hooks/useAnnouncement'
import useSidebarCollapse from './dashboard/hooks/useSidebarCollapse'
import useDashboardData from './dashboard/hooks/useDashboardData'
import useTradeActions from './dashboard/hooks/useTradeActions'
import useAccountActions from './dashboard/hooks/useAccountActions'
import useKycForm from './dashboard/hooks/useKycForm'
import useKycStatusPolling from './dashboard/hooks/useKycStatusPolling'
import useDashboardSocket from './dashboard/hooks/useDashboardSocket'
import CertificateCelebrationModal from '../components/CertificateCelebrationModal'

const TradingPanel = lazy(() => import('../components/TradingPanel'))
const Analytics = lazy(() => import('./Analytics'))
// recharts-based — lazy so a trader who never opens these tabs never pulls
// the chart chunk into their first /dashboard load (unlike DashboardHome,
// which needs its charts immediately, these can show a fallback while the
// chunk loads on demand).
const DashboardPayoutsPage = lazy(() => import('./DashboardPayoutsPage'))
const DashboardAffiliatePage = lazy(() => import('./DashboardAffiliatePage'))
const DashboardCertificatesPage = lazy(() => import('./DashboardCertificatesPage'))
const DashboardTradeHistoryPage = lazy(() => import('./DashboardTradeHistoryPage'))

// Header breadcrumb + page title per screen (Modern Gazette handoff spec
// TITLES map — breadcrumb is a separate, narrower label than the sidebar
// nav group name, e.g. 'dispute' breadcrumbs under "Support" even though
// its nav item lives in the Help group).
const PAGE_TITLES = {
  dashboard: ['Trader Desk', null], // title is the personalized greeting, built at render time
  trade: ['Trading Desk', 'Order Ticket & Chart'],
  analytics: ['Trader Desk', 'Performance Analytics'],
  compare: ['Trader Desk', 'Compare Accounts'],
  competitions: ['Programme', 'Competitions & Leaderboard'],
  rules: ['Programme', 'Challenge Rules'],
  history: ['Programme', 'Trade History'],
  kyc: ['Account', 'Identity Verification'],
  payouts: ['Account', 'Payouts'],
  chat: ['Support', 'Live Chat with the Desk'],
  dispute: ['Support', 'File an Appeal'],
  'get-challenge': ['Programme', 'New Challenge'],
  affiliate: ['Account', 'Affiliate'],
  support: ['Support', 'Support'],
  certificates: ['Account', 'Certificates & Achievements'],
  profile: ['Account', 'Profile'],
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function DashboardSectionFallback({ label = 'Loading module...' }) {
  return (
    <div
      className="lx-card ui-surface ui-empty-state"
      style={{
        padding: 'var(--space-7)',
        minHeight: '220px',
        color: 'var(--text-muted)'
      }}
    >
      {label}
    </div>
  )
}

function Dashboard({ user, onLogout }) {
  const { login } = useAuth()
  // Dashboard views are URL-addressable (/dashboard/<view>) so back/forward,
  // refresh, and bookmarking all work — activePage derives from the current
  // route instead of being local-only state. setActivePage keeps its old
  // signature (a page id string) so every existing caller (Sidebar,
  // CommandPalette, Onboarding, child pages) needed no changes.
  const location = useLocation()
  const navigate = useNavigate()
  const activePage = location.pathname.replace(/^\/dashboard\/?/, '').split('/')[0] || 'dashboard'
  const setActivePage = (page) => navigate(page === 'dashboard' ? '/dashboard' : `/dashboard/${page}`)

  const [showOnboarding, setShowOnboarding] = useState(() => shouldShowOnboarding())

  const { error, setError, success, setSuccess } = useDashboardFeedback()
  const { sidebarCollapsed, handleToggleSidebar } = useSidebarCollapse()
  const { announcement, announcementDismissed, dismissAnnouncement } = useAnnouncement()
  const {
    notifications,
    showNotifications,
    setShowNotifications,
    notifRef,
    notifButtonRef,
    pushNotification,
    markAllRead,
    clearNotifications
  } = useNotifications()

  const {
    stats,
    accountRules,
    tradeHistory,
    payouts,
    accountHistory,
    profitSharePct,
    accountLoading,
    accounts,
    visibleAccounts,
    selectedAccount,
    setSelectedAccount,
    selectedAccountRef,
    pricesRef,
    prices,
    fetchAccounts,
    fetchStats,
    fetchOpenTrades,
    fetchTradeHistory,
    fetchPayouts,
    fetchAccountHistory,
    refreshSelectedAccount
  } = useDashboardData({ setError })

  const openTrades = useStore((s) => s.openPositions)

  const kyc = useKycForm({ user, setError, setSuccess })
  useKycStatusPolling(kyc.kycStatus, kyc.setKycStatus)

  const {
    orderForm,
    setOrderForm,
    closingTradeIds,
    openTrade,
    closeTrade,
    cancelOrder,
    handleTradeModified
  } = useTradeActions({
    selectedAccount,
    setError,
    setSuccess,
    fetchOpenTrades,
    fetchStats,
    fetchTradeHistory
  })

  const {
    createAccount,
    quotaFull,
    quotaNextOpen,
    payoutForm,
    setPayoutForm,
    requestPayout,
    profileForm,
    setProfileForm,
    profileSaving,
    updateProfile
  } = useAccountActions({
    user,
    login,
    selectedAccount,
    setError,
    setSuccess,
    fetchAccounts,
    fetchPayouts
  })

  // Set by the certificate_awarded socket event; cleared when the trader
  // dismisses the celebration.
  const [awardedCertificate, setAwardedCertificate] = useState(null)

  useDashboardSocket({
    user,
    pricesRef,
    selectedAccountRef,
    setError,
    setSuccess,
    setKycStatus: kyc.setKycStatus,
    setSelectedAccount,
    pushNotification,
    refreshSelectedAccount,
    fetchAccounts,
    fetchAccountHistory,
    onCertificateAwarded: setAwardedCertificate
  })

  const fundedAccount = accounts.find(a => a.account_type === 'funded' && a.status === 'active')
  const availableProfit = fundedAccount
    ? Math.max(0, calculateRealizedProfit(fundedAccount.current_balance, fundedAccount.starting_balance))
    : 0

  return (
    <div className="mode-trader ui-shell dashboard-layout">

      {/* ── Onboarding walkthrough — shown on first login ── */}
      {showOnboarding && (
        <Onboarding
          onComplete={() => setShowOnboarding(false)}
          onNavigate={(page) => {
            setShowOnboarding(false)
            setActivePage(page)
          }}
        />
      )}

      {/* ── Platform Announcement Banner ── */}
      {announcement && !announcementDismissed && (() => {
        // FIX (BUG-L3): All four types rendered identical grey shades; now uses proper semantic colors
        const colors = {
          info:    { bg: 'transparent', border: 'var(--rule)', text: 'var(--ink)', icon: 'info' },
          warning: { bg: 'transparent', border: 'var(--warn)', text: 'var(--warn)', icon: 'warning' },
          success: { bg: 'transparent', border: 'var(--gain)', text: 'var(--gain)', icon: 'approve' },
          error:   { bg: 'transparent', border: 'var(--loss)', text: 'var(--loss)', icon: 'reject' },
        }
        const c = colors[announcement.type] || colors.info
        return (
          <div style={{
            background: c.bg, borderBottom: `1px solid ${c.border}`,
            padding: 'var(--space-2-5) var(--space-6)',
            display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)',
            position: 'sticky', top: '57px', zIndex: 90
          }}>
            <span style={{ display: 'inline-flex' }}>
              {renderIcon(c.icon, { size: 16, color: c.text })}
            </span>
            <span style={{ flex: 1, fontSize: 'var(--fs-base)', color: c.text, fontWeight: '500' }}>
              {announcement.message}
            </span>
            <button
              onClick={dismissAnnouncement}
              aria-label="Dismiss announcement"
              style={{ background: 'none', border: 'none', color: c.text, cursor: 'pointer', fontSize: 'var(--fs-lg)', opacity: 0.7, padding: '0 var(--space-1)' }}
            >
              {renderIcon('close', { size: 16, color: c.text })}
            </button>
          </div>
        )
      })()}

      <Sidebar
        user={user}
        activePage={activePage}
        setActivePage={setActivePage}
        kycStatus={kyc.kycStatus}
        pendingPayouts={payouts.filter(p => p.status === 'pending').length}
        unreadNotifications={notifications.filter(n => !n.read).length}
        onLogout={onLogout}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
      />

      <CommandPalette
        results={NAV_GROUPS.flatMap((group) => group.items.map((item) => ({
          label: item.label,
          group: group.label,
          action: item.externalPath
            ? () => (item.openInNewTab ? window.open(item.externalPath, '_blank', 'noopener') : navigate(item.externalPath))
            : () => setActivePage(item.id),
        })))}
      />

      {/* Main Content — .sidebar is position:fixed (stays pinned, only its
          own nav list scrolls internally), so main content needs an
          explicit offset instead of relying on flex to push it over.
          Class-based (not inline) so the mobile media query can still
          override it — see .dashboard-main rules in App.css. */}
      {/* data-view lets CSS treat one screen differently without a second
          layout: on mobile the Trade view un-sticks this topbar so the trading
          terminal's own price header can pin instead — two sticky bars both at
          top: 0 would otherwise stack to 253px of a 692px phone, with the
          symbol and bid/ask hidden underneath. */}
      <div
        data-view={activePage}
        className={`dashboard-main animate-fade-up ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
        {/* Top Nav — flush, full-width header matching the prototype exactly
            (breadcrumb + Playfair title, search, MARKETS OPEN — no floating
            card/margin, that's what was creating the visible gap around it). */}
      <div className="nav dashboard-topbar" style={{
        margin: 0,
        padding: 'var(--space-3-5) var(--space-6)',
        display: 'flex', alignItems: 'center', gap: 'var(--space-4)',
        background: 'var(--glass)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        borderBottom: '1px solid var(--rule)',
        borderRadius: 0,
        boxShadow: 'none',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            {(PAGE_TITLES[activePage] || ['Trader Desk'])[0]}
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '23px', fontWeight: 500, margin: '2px 0 0', letterSpacing: '-.01em' }}>
            {activePage === 'dashboard'
              ? `${greeting()}, ${(user?.full_name || 'Trader').split(' ')[0]}`
              : (PAGE_TITLES[activePage]?.[1] || 'Dashboard')}
          </h1>
        </div>
        <div style={{ flex: 1 }} />
        <CommandPaletteTrigger />
        <MarketStatusPill />

        {/* ── Notification Bell ── */}
        <div style={{ position: 'relative' }} ref={notifRef}>
          <button
            ref={notifButtonRef}
            onClick={() => {
              setShowNotifications(p => {
                if (!p) markAllRead()
                return !p
              })
            }}
            aria-label={`Notifications${notifications.filter(n => !n.read).length > 0 ? ` (${notifications.filter(n => !n.read).length} unread)` : ''}`}
            aria-haspopup="true"
            aria-expanded={showNotifications}
            style={{ display: 'flex', alignItems: 'center', padding: 'var(--space-2)', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)', color: 'var(--muted)' }}
          >
            {renderIcon('bell', { size: 15, color: 'var(--muted)' })}
            {notifications.filter(n => !n.read).length > 0 && (
              <span className="lx-badge" style={{
                position: 'absolute', top: '-6px', right: '-6px', color: 'var(--loss)',
                padding: '1px 5px', fontSize: 'var(--fs-3xs)',
              }}>
                {notifications.filter(n => !n.read).length}
              </span>
            )}
          </button>
          {/* Popover geometry (width, max-height, anchoring) comes from
              .dashboard-notification-popover in App.css, which already caps it
              at min(320px, 100vw - 32px). An inline width: 320px used to sit
              here and beat that cap, so the popover overhung the viewport on a
              small phone. Only the surface treatment stays inline. */}
          {showNotifications && (
            <div role="dialog" aria-label="Notifications" className="dashboard-notification-popover" style={{
              background: 'var(--glass-2)', backdropFilter: 'blur(24px) saturate(160%)', WebkitBackdropFilter: 'blur(24px) saturate(160%)',
              border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-lg)'
            }}>
              <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--rule)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-md)', color: 'var(--accent)' }}>Notifications</span>
                {notifications.length > 0 && (
                  <button onClick={clearNotifications} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', fontSize: 'var(--fs-xs)', cursor: 'pointer' }}>Clear all</button>
                )}
              </div>
              <div style={{ overflowY: 'auto', maxHeight: '340px' }}>
                {notifications.length === 0 ? (
                  <div style={{ padding: 'var(--space-7) var(--space-4)', textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--fs-base)' }}>No notifications yet</div>
                ) : (
                  notifications.map(n => (
                    <div key={n.id} style={{
                      padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--rule-soft)',
                      borderLeft: `3px solid ${n.type === 'error' ? 'var(--loss)' : n.type === 'success' ? 'var(--gain)' : 'var(--accent)'}`,
                    }}>
                      <div style={{ fontSize: 'var(--fs-base)', color: 'var(--ink)', marginBottom: 'var(--space-1)' }}>{n.message}</div>
                      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>
                        {new Date(n.time).toLocaleString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-page-content dashboard-page-stack">
        {error && <div className="error" role="alert" aria-live="assertive">{error}</div>}
        {success && <div className="success" role="status" aria-live="polite">{success}</div>}

        {/* Dashboard Page */}
        {activePage === 'dashboard' && (
          <DashboardHome
            user={user}
            stats={stats}
            openTrades={openTrades}
            accounts={visibleAccounts}
            selectedAccount={selectedAccount}
            setSelectedAccount={setSelectedAccount}
            getStatusColor={getStatusColor}
            profitSharePct={profitSharePct}
            quotaFull={quotaFull}
            quotaNextOpen={quotaNextOpen}
            onOpenRulesPage={() => setActivePage('rules')}
            onStartChallenge={() => setActivePage('get-challenge')}
            onOpenPayoutsPage={() => setActivePage('payouts')}
          />
        )}

        {/* Profile Page */}
        {activePage === 'profile' && (
          <DashboardProfilePage
            kycStatus={kyc.kycStatus}
            profileForm={profileForm}
            setProfileForm={setProfileForm}
            updateProfile={updateProfile}
            profileSaving={profileSaving}
            API_URL={API_URL}
          />
        )}

        {activePage === 'get-challenge' && (
          <GetChallenge
            onCreateAccount={createAccount}
            kycStatus={kyc.kycStatus}
            setActivePage={setActivePage}
          />
        )}

        {activePage === 'rules' && (
          <ChallengeRules
            selectedAccount={selectedAccount}
            accountRules={accountRules}
            stats={stats}
            openTrades={openTrades}
            onTradeNow={() => setActivePage('trade')}
          />
        )}

        {/* Trade Page */}
        {activePage === 'trade' && (
          kyc.kycStatus !== 'approved' ? (
            <Card style={{ textAlign: 'center', padding: 'var(--space-9)' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
                {renderIcon('kyc', { size: 48, color: 'var(--accent)' })}
              </div>
              <h3 className="page-title" style={{ marginBottom: 'var(--space-3)', fontSize: 'var(--fs-2xl)' }}>KYC Required</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-5)' }}>Complete your identity verification to start trading.</p>
              <button className="btn btn-primary" onClick={() => setActivePage('kyc')} style={{ padding: 'var(--space-3) var(--space-7)' }}>Complete KYC</button>
            </Card>
          ) : (
            // FIX (AUDIT): TradingPanel is a ~1700-line component with its own
            // chart/order-form/batch-action state — a rendering crash in it
            // used to take down the entire app via the single app-wide
            // boundary. Scoped here so a crash falls back in place instead.
            <ErrorBoundary variant="section" label="Trading Panel" key={selectedAccount?.id}>
              <Suspense fallback={<DashboardSectionFallback label="Loading trading terminal..." />}>
                <TradingPanel
                  prices={prices}
                  selectedAccount={selectedAccount}
                  accounts={visibleAccounts}
                  setSelectedAccount={setSelectedAccount}
                  openTrades={openTrades}
                  tradeHistory={tradeHistory}
                  orderForm={orderForm}
                  setOrderForm={setOrderForm}
                  onOpenTrade={openTrade}
                  onCloseTrade={closeTrade}
                  closingTradeIds={closingTradeIds}
                  onCancelOrder={cancelOrder}
                  getStatusColor={getStatusColor}
                  stats={stats}

                  onTradeModified={handleTradeModified}
                  accountLoading={accountLoading}
                />
              </Suspense>
            </ErrorBoundary>
          )
        )}

        {/* Analytics Page */}
        {activePage === 'analytics' && (
          <ErrorBoundary variant="section" label="Analytics">
            <Suspense fallback={<DashboardSectionFallback label="Loading analytics..." />}>
              <Analytics
                selectedAccount={selectedAccount}

              />
            </Suspense>
          </ErrorBoundary>
        )}

        {/* Compare Accounts Page */}
        {activePage === 'compare' && (
          <DashboardComparePage accounts={visibleAccounts} />
        )}

        {/* KYC Page */}
        {activePage === 'kyc' && (
          // useKycForm returns exactly the props this page takes, so spreading
          // it keeps the two in step instead of restating 16 bindings here.
          <DashboardKYCPage user={user} {...kyc} />
        )}

        {/* Payouts Page */}
        {activePage === 'payouts' && (
          <ErrorBoundary variant="section" label="Payouts">
            <Suspense fallback={<DashboardSectionFallback label="Loading payouts..." />}>
              <DashboardPayoutsPage
                user={user}
                fundedAccount={fundedAccount}
                payouts={payouts}
                payoutForm={payoutForm}
                setPayoutForm={setPayoutForm}
                requestPayout={requestPayout}
                availableProfit={availableProfit}
                profitSharePct={profitSharePct}
                API_URL={API_URL}
              />
            </Suspense>
          </ErrorBoundary>
        )}

        {/* Certificates & Achievements */}
        {activePage === 'certificates' && (
          <ErrorBoundary variant="section" label="Certificates">
            <Suspense fallback={<DashboardSectionFallback label="Loading certificates..." />}>
              <DashboardCertificatesPage />
            </Suspense>
          </ErrorBoundary>
        )}

        {/* Affiliate Page */}
        {activePage === 'affiliate' && (
          <ErrorBoundary variant="section" label="Affiliate">
            <Suspense fallback={<DashboardSectionFallback label="Loading affiliate program..." />}>
              <DashboardAffiliatePage />
            </Suspense>
          </ErrorBoundary>
        )}

        {/* Competitions Page */}
        {activePage === 'competitions' && (
          <ErrorBoundary variant="section" label="Competitions">
            <DashboardCompetitionsPage />
          </ErrorBoundary>
        )}

        {/* Account History Page */}
        {activePage === 'history' && (
          <ErrorBoundary variant="section" label="Trade History">
            <Suspense fallback={<DashboardSectionFallback label="Loading trade history..." />}>
              <DashboardTradeHistoryPage selectedAccount={selectedAccount} accountHistory={accountHistory} />
            </Suspense>
          </ErrorBoundary>
        )}

        {/* Support Page */}
        {activePage === 'support' && (
          <Support user={user} />
        )}

        {/* Dispute Page */}
        {activePage === 'dispute' && (
          <Dispute user={user} accounts={accounts} />
        )}

        {/* Live Chat Page */}
        {activePage === 'chat' && (
          <Chat />
        )}

      </div>
      </div>

      {/* Sits at the shell root, outside the page-content wrapper, so it
          overlays whichever tab the trader happens to be on when the award
          lands. */}
      <CertificateCelebrationModal
        certificate={awardedCertificate}
        open={Boolean(awardedCertificate)}
        onClose={() => setAwardedCertificate(null)}
        onView={() => { setAwardedCertificate(null); setActivePage('certificates') }}
      />
    </div>
  )
}

export default Dashboard
