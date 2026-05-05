'use strict'

const COPIER_POLICY_OPTIONS = ['ignore', 'mirror', 'reverse']

function normalizeBooleanSetting(value, defaultValue = false) {
  if (value == null) return defaultValue
  return String(value).toLowerCase() !== 'false'
}

function normalizeNumberSetting(value, defaultValue = 1) {
  const parsed = parseFloat(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue
  return parsed
}

function deriveLegacyPolicies() {
  return {
    policy_phase1: 'ignore',
    policy_phase2: 'ignore',
    policy_funded: 'mirror'
  }
}

function normalizePolicy(value, fallback = 'ignore') {
  const normalized = String(value || fallback).toLowerCase()
  return COPIER_POLICY_OPTIONS.includes(normalized) ? normalized : fallback
}

function parseCopierConfigMap(settingsMap = {}) {
  const legacyPolicies = deriveLegacyPolicies()

  return {
    enabled: normalizeBooleanSetting(settingsMap.copier_enabled, true),
    lot_multiplier: normalizeNumberSetting(settingsMap.copier_lot_multiplier, 1),
    policy_phase1: normalizePolicy(settingsMap.copier_policy_phase1, legacyPolicies.policy_phase1),
    policy_phase2: normalizePolicy(settingsMap.copier_policy_phase2, legacyPolicies.policy_phase2),
    policy_funded: normalizePolicy(settingsMap.copier_policy_funded, legacyPolicies.policy_funded)
  }
}

function parseCopierConfigRows(rows = []) {
  const settingsMap = {}
  for (const row of rows) {
    settingsMap[row.key] = row.value
  }
  return parseCopierConfigMap(settingsMap)
}

function buildCopierSettingsUpdates(config = {}) {
  const updates = {}

  if (config.enabled !== undefined) {
    updates.copier_enabled = String(Boolean(config.enabled))
  }
  if (config.lot_multiplier !== undefined) {
    updates.copier_lot_multiplier = String(normalizeNumberSetting(config.lot_multiplier, 1))
  }
  if (config.policy_phase1 !== undefined) {
    updates.copier_policy_phase1 = normalizePolicy(config.policy_phase1)
  }
  if (config.policy_phase2 !== undefined) {
    updates.copier_policy_phase2 = normalizePolicy(config.policy_phase2)
  }
  if (config.policy_funded !== undefined) {
    updates.copier_policy_funded = normalizePolicy(config.policy_funded, 'mirror')
  }

  return updates
}

function getCopierPolicyForAccountType(accountType, config = {}) {
  const normalizedType = String(accountType || '').toLowerCase()
  if (normalizedType === 'phase1') return normalizePolicy(config.policy_phase1, 'ignore')
  if (normalizedType === 'phase2') return normalizePolicy(config.policy_phase2, 'ignore')
  if (normalizedType === 'funded') return normalizePolicy(config.policy_funded, 'mirror')
  return 'ignore'
}

function resolveCopiedDirection(direction, policy) {
  const normalizedDirection = String(direction || '').toLowerCase()
  if (policy !== 'reverse') return normalizedDirection
  if (normalizedDirection === 'buy') return 'sell'
  if (normalizedDirection === 'sell') return 'buy'
  return normalizedDirection
}

module.exports = {
  COPIER_POLICY_OPTIONS,
  buildCopierSettingsUpdates,
  deriveLegacyPolicies,
  getCopierPolicyForAccountType,
  parseCopierConfigMap,
  parseCopierConfigRows,
  resolveCopiedDirection
}
