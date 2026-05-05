import { calculatePnL } from './instruments'

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
    locked: '#8a8a8a',
  }

  return colors[status] || 'var(--text-muted)'
}
