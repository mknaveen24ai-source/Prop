/**
 * The single status-tone map for the whole app (trader + admin). Modern
 * Gazette handoff spec: "one map, every representation" — every status
 * pill, dot, chart segment and colored figure resolves through these
 * exact 5 tones, never a bespoke color.
 *
 *   gain   (green) — Funded, Passed, Clear, Paid, Resolved, Verified
 *   accent (gold/red, theme-dependent) — Open, Approved, Phase 2, Active
 *   warn   (amber) — Phase 1, Pending, Review, Warning, Upcoming, Appealed, Processing
 *   muted  (gray)  — Notice, Closed, Expired, Locked
 *   loss   (red)   — Breached, Critical, Failed, Rejected, Enforced, Banned, Cancelled
 *
 * Statuses outside the spec's illustrative list are bucketed by judgment
 * call above (extend here, don't fork a parallel table elsewhere).
 */
export const STATUS_TONES = ['gain', 'accent', 'warn', 'muted', 'loss']

const TONE_KEYWORDS = {
  gain: ['funded', 'passed', 'clear', 'paid', 'resolved', 'verified', 'success', 'available', 'completed', 'won'],
  accent: ['open', 'approved', 'phase 2', 'phase2', 'active'],
  warn: ['phase 1', 'phase1', 'pending', 'review', 'under review', 'warning', 'upcoming', 'appealed', 'processing'],
  muted: ['notice', 'closed', 'expired', 'locked', 'adjusted', 'neutral', 'info'],
  loss: ['breached', 'breach', 'critical', 'failed', 'rejected', 'enforced', 'banned', 'cancelled', 'canceled', 'danger'],
}

const TONE_LABELS = {
  gain: 'Gain',
  accent: 'Accent',
  warn: 'Warn',
  muted: 'Muted',
  loss: 'Loss',
}

/** Normalize any status string/label to one of the 5 tone keys above. */
export function normalizeStatusTone(status) {
  const normalized = String(status || '').trim().toLowerCase()
  for (const tone of STATUS_TONES) {
    if (TONE_KEYWORDS[tone].includes(normalized)) return tone
  }
  return 'muted'
}

/** CSS color for a status — for badges, chart segments, dots, colored figures. */
export function getStatusToneColor(status) {
  return `var(--${normalizeStatusTone(status)})`
}

export function getStatusToneLabel(status) {
  return TONE_LABELS[normalizeStatusTone(status)]
}
