/**
 * Flat list of admin nav destinations for the command palette. Mirrors
 * AdminSidebar.jsx's grouped nav (kept as a separate small data list rather
 * than refactoring AdminSidebar's JSX into data, since that component also
 * threads in live badge counts per item).
 */
export function buildAdminNavResults({ isSuperAdmin, navigate }) {
  const groups = [
    { label: 'Overview', items: [['/admin', 'Dashboard']] },
    {
      label: 'Traders',
      items: [
        ['/admin/users', 'All Users'],
        ['/admin/kyc', 'KYC Approvals'],
        ['/admin/challenges', 'Challenges'],
        ['/admin/promotion-reviews', 'Promotion Review'],
        ['/admin/funded', 'Funded Accounts'],
      ],
    },
    {
      label: 'Trading',
      items: [
        ['/admin/trades', 'All Trades'],
        ['/admin/competitions', 'Competitions'],
      ],
    },
    { label: 'Analytics', items: [['/admin/analytics', 'Analytics']] },
    {
      label: 'Support',
      items: [
        ['/admin/chat', 'Chat'],
        ['/admin/disputes', 'Disputes'],
      ],
    },
    {
      label: 'Finance',
      items: [
        ['/admin/payouts', 'Payouts'],
        ['/admin/affiliates', 'Affiliates'],
        ['/admin/affiliates/payouts', 'Affiliate Payouts'],
        ...(isSuperAdmin ? [['/admin/pnl', 'Platform P&L']] : []),
      ],
    },
    {
      label: 'Platform',
      items: [
        ...(isSuperAdmin ? [['/admin/command-center', 'Command Center']] : []),
        ['/admin/access', 'Access & Security'],
        ['/admin/settings', 'Settings'],
        ['/admin/trading-economics', 'Trading Economics'],
        ...(isSuperAdmin ? [['/admin/step-models', 'Challenge Models']] : []),
        ['/admin/violations', 'Violations'],
        ['/admin/leaderboard', 'Leaderboard'],
      ],
    },
  ]

  return groups.flatMap((group) =>
    group.items.map(([path, label]) => ({
      label,
      group: group.label,
      action: () => navigate(path),
    }))
  )
}
