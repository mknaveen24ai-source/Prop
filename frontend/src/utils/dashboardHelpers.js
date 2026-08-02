import { calculatePnL } from './instruments.js'

export { calculatePnL }

export function getStatusColor(status) {
  const colors = {
    active: 'var(--accent)',
    passed: 'var(--green)',
    failed: 'var(--red)',
    funded: 'var(--cyan)',
    pending: 'var(--accent)',
    approved: 'var(--green)',
    paid: 'var(--green)',
    rejected: 'var(--red)',
    locked: 'var(--muted)',
  }

  return colors[status] || 'var(--text-muted)'
}
