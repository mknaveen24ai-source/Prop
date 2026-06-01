export const TRADER_ACCOUNT_VISIBLE_MONTHS = 2

function parseDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function getTraderAccountArchiveDate(now = Date.now()) {
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - TRADER_ACCOUNT_VISIBLE_MONTHS)
  return cutoff
}

export function getTraderAccountAgeDate(account) {
  return parseDate(
    account?.created_at ||
    account?.createdAt ||
    account?.phase_start_date ||
    account?.start_date ||
    account?.opened_at
  )
}

export function isTraderAccountVisible(account, now = Date.now()) {
  const ageDate = getTraderAccountAgeDate(account)
  if (!ageDate) return true
  return ageDate >= getTraderAccountArchiveDate(now)
}

export function filterVisibleTraderAccounts(accounts = [], now = Date.now()) {
  if (!Array.isArray(accounts)) return []
  return accounts.filter((account) => isTraderAccountVisible(account, now))
}
