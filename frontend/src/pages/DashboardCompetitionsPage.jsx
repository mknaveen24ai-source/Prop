import React, { useState } from 'react'
import { CompetitionsListContent } from './Competitions'
import { CompetitionDetailContent } from './CompetitionDetail'
import { TraderProfileContent } from './TraderProfile'

/**
 * DashboardCompetitionsPage — Competitions tab, rendered inside the trader
 * dashboard shell (Sidebar stays mounted, unlike the standalone /competitions
 * route). Toggles locally between the list, a selected competition's detail
 * view, and a selected trader's profile instead of navigating away — so
 * clicking a leaderboard entry never leaves the dashboard shell either.
 */
export default function DashboardCompetitionsPage() {
  const [selectedSlug, setSelectedSlug] = useState(null)
  const [viewingUserId, setViewingUserId] = useState(null)

  if (viewingUserId) {
    return <TraderProfileContent userId={viewingUserId} onBack={() => setViewingUserId(null)} />
  }

  return selectedSlug
    ? <CompetitionDetailContent slug={selectedSlug} onBack={() => setSelectedSlug(null)} onSelectTrader={setViewingUserId} />
    : <CompetitionsListContent onSelectSlug={setSelectedSlug} />
}
