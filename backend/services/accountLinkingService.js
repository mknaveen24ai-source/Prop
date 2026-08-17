/**
 * Account sharing / passing-service detection.
 *
 * Unregulated "passing services" take a trader's credentials and pass challenges
 * on their behalf, running many customers' accounts at once through copy-trading
 * software. This service correlates the traces that leaves:
 *
 *   - shared network origin (exact IP, and the /24 subnet it sits in)
 *   - shared device (canvas/WebGL/audio fingerprint and its components)
 *   - near-simultaneous order flow across supposedly unrelated accounts
 *   - shared payout destination and shared KYC document
 *
 * Signals are captured by services/identitySignals.js into identity_signals.
 * This module reads them, groups users into clusters, scores each cluster, and
 * writes the result to account_link_clusters for admin review.
 *
 * ── The thing that makes or breaks this ──────────────────────────────────────
 *
 * Entropy weighting. A corporate NAT, a university, or a VPN exit node is shared
 * by hundreds of legitimate users. Safari's fingerprint randomisation and
 * Brave's farbling make many unrelated users produce an identical canvas hash.
 * So a shared value is only evidence when it is RARE:
 *
 *   - values shared by more than a per-type ceiling are dropped outright, which
 *     also prevents the cluster-explosion failure mode where one VPN exit merges
 *     the entire user base into a single meaningless cluster
 *   - below the ceiling, weight decays with the number of users sharing the value
 *
 * ── What this deliberately does NOT do ───────────────────────────────────────
 *
 * It never locks, flags or bans. Detection is probabilistic — device signatures
 * are client-supplied and spoofable, IPs are shared innocently every day — so
 * the output is a scored review queue, not an enforcement action. This replaced
 * challengeEngine.detectIPMultiAccounts, which auto-flagged any two users
 * sharing an exact IP within 24h.
 */

const crypto = require('crypto')
const pool = require('../db')
const logger = require('../utils/logger')
const { recordViolation } = require('./violationEngine')
const { SIGNAL_TYPES } = require('./identitySignals')

// ── Tuning ───────────────────────────────────────────────────────────────────

const SIGNAL_LOOKBACK_DAYS = 30
const TRADE_WINDOW_HOURS = 48

// Two trades count as simultaneous within this many milliseconds. Copy software
// replicates in well under a second; 5s is generous enough to absorb broker
// latency without sweeping in unrelated reactions to the same news event.
const SIMULTANEITY_WINDOW_MS = 5000

// Below this many matched trades a pair is coincidence, not copying. Two users
// both buying EURUSD on an NFP spike is normal; six times in a row is not.
const MIN_MATCHED_TRADES = 5

// Above these many distinct users, a shared value is infrastructure rather than
// a link. Tuned per type: an ISP /24 legitimately covers many customers, a
// passport number covers exactly one person.
const MAX_USERS_PER_SIGNAL = Object.freeze({
  [SIGNAL_TYPES.KYC_DOC]: 6,
  [SIGNAL_TYPES.PAYOUT_DEST]: 12,
  [SIGNAL_TYPES.IP_SUBNET]: 15,
  [SIGNAL_TYPES.DEVICE_FP]: 25,
  [SIGNAL_TYPES.DEVICE_COMPONENT]: 25,
  [SIGNAL_TYPES.IP]: 25
})
const DEFAULT_MAX_USERS_PER_SIGNAL = 20

// Full weight up to this many sharers, then decay.
const FULL_WEIGHT_USERS = 4

const SIGNAL_WEIGHTS = Object.freeze({
  [SIGNAL_TYPES.PAYOUT_DEST]: 50,
  [SIGNAL_TYPES.KYC_DOC]: 50,
  [SIGNAL_TYPES.DEVICE_FP]: 40,
  [SIGNAL_TYPES.DEVICE_COMPONENT]: 20,
  [SIGNAL_TYPES.IP]: 15,
  [SIGNAL_TYPES.IP_SUBNET]: 8
})

const SIMULTANEITY_STRONG_THRESHOLD = 0.70
const SIMULTANEITY_WEAK_THRESHOLD = 0.40
const SIMULTANEITY_STRONG_WEIGHT = 45
const SIMULTANEITY_WEAK_WEIGHT = 25

// Clusters larger than this are more likely shared infrastructure than a ring.
const CLUSTER_SIZE_SOFT_LIMIT = 15

const MIN_PERSISTED_SCORE = 30   // below this the cluster is discarded entirely
const MEDIUM_CONFIDENCE_SCORE = 60
const HIGH_CONFIDENCE_SCORE = 80

// Violations (and therefore admin toasts) fire only at medium+. Low-confidence
// clusters still land in the review queue, they just do not page anyone.
const MIN_VIOLATION_SCORE = MEDIUM_CONFIDENCE_SCORE

// Query guards so one pathological scan cannot exhaust memory.
const MAX_SHARED_SIGNAL_ROWS = 5000
const MAX_TRADE_ROWS = 50000
const MAX_CANDIDATE_PAIRS = 3000

// ── Pure helpers (exported for testing) ──────────────────────────────────────

/**
 * Weight multiplier for a value shared by `distinctUsers` users.
 * 1.0 up to FULL_WEIGHT_USERS, then decays harmonically.
 */
function entropyFactor (distinctUsers) {
  const users = Number(distinctUsers) || 0
  if (users <= FULL_WEIGHT_USERS) return 1
  return FULL_WEIGHT_USERS / users
}

/**
 * Large clusters are damped — a 40-user "ring" is almost always an office,
 * a shared ISP block or a VPN, not forty colluding accounts.
 */
function clusterSizeFactor (memberCount) {
  const count = Number(memberCount) || 0
  if (count <= CLUSTER_SIZE_SOFT_LIMIT) return 1
  return CLUSTER_SIZE_SOFT_LIMIT / count
}

function confidenceForScore (score) {
  if (score >= HIGH_CONFIDENCE_SCORE) return 'high'
  if (score >= MEDIUM_CONFIDENCE_SCORE) return 'medium'
  return 'low'
}

/**
 * Union-Find over user-id pairs. Returns an array of clusters (arrays of ids),
 * each with 2+ members, sorted for stable cluster keys.
 */
function buildClusters (pairs) {
  const parent = new Map()

  function find (x) {
    if (!parent.has(x)) parent.set(x, x)
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)
    // Path compression.
    let cursor = x
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }

  function union (a, b) {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }

  for (const [a, b] of pairs) {
    if (!a || !b || a === b) continue
    union(a, b)
  }

  const groups = new Map()
  for (const node of parent.keys()) {
    const root = find(node)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(node)
  }

  return Array.from(groups.values())
    .filter(members => members.length >= 2)
    .map(members => members.slice().sort())
}

/**
 * Stable identity for a cluster: the sorted member set.
 *
 * Because membership IS the key, a re-scan that finds the same ring updates the
 * existing row and preserves whatever an admin decided about it. A ring that
 * gains or loses a member becomes a new cluster, which is the correct outcome —
 * it is a different finding and deserves a fresh look.
 */
function buildClusterKey (memberIds) {
  const sorted = memberIds.slice().sort().join('|')
  return crypto.createHash('sha256').update(sorted).digest('hex')
}

/**
 * All unordered pairs from a member list.
 */
function pairsFrom (members) {
  const out = []
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      out.push([members[i], members[j]])
    }
  }
  return out
}

/**
 * Greedy two-pointer match of two time-sorted trade lists.
 *
 * Returns the overlap coefficient: matched / min(|a|, |b|). Using min rather
 * than union means a service copying a 10-trade master into an account that also
 * trades manually still scores high, which is the realistic case.
 *
 * Each trade on either side can be consumed at most once, so one burst of orders
 * cannot match repeatedly and inflate the score.
 */
function overlapCoefficient (tradesA, tradesB, windowMs = SIMULTANEITY_WINDOW_MS) {
  if (!tradesA.length || !tradesB.length) return { overlap: 0, matched: 0 }

  const consumed = new Array(tradesB.length).fill(false)
  let matched = 0
  let cursor = 0

  for (const trade of tradesA) {
    // Advance past anything that can no longer match.
    while (cursor < tradesB.length && tradesB[cursor].time < trade.time - windowMs) {
      cursor += 1
    }
    for (let k = cursor; k < tradesB.length; k += 1) {
      const other = tradesB[k]
      if (other.time > trade.time + windowMs) break
      if (consumed[k]) continue
      if (other.instrument !== trade.instrument) continue
      if (other.direction !== trade.direction) continue
      consumed[k] = true
      matched += 1
      break
    }
  }

  const overlap = matched / Math.min(tradesA.length, tradesB.length)
  return { overlap, matched }
}

/**
 * Score a cluster from its evidence. Returns { score, confidence }.
 */
function scoreCluster (memberCount, evidence) {
  let raw = 0
  for (const item of evidence) {
    raw += Number(item.weight) || 0
  }
  const score = Math.min(100, Math.round(raw * clusterSizeFactor(memberCount)))
  return { score, confidence: confidenceForScore(score) }
}

// ── Data access ──────────────────────────────────────────────────────────────

/**
 * Signal values seen on more than one user inside the lookback window, with the
 * per-type ceiling applied in SQL so oversized groups never reach memory.
 */
async function fetchSharedSignals (lookbackDays = SIGNAL_LOOKBACK_DAYS) {
  const result = await pool.query(
    `SELECT signal_type,
            signal_value,
            COUNT(DISTINCT user_id)::int      AS distinct_users,
            ARRAY_AGG(DISTINCT user_id)       AS user_ids,
            MAX(last_seen_at)                 AS last_seen_at
       FROM identity_signals
      WHERE last_seen_at > NOW() - ($1 || ' days')::interval
      GROUP BY signal_type, signal_value
     HAVING COUNT(DISTINCT user_id) > 1
        AND COUNT(DISTINCT user_id) <= COALESCE(
              ($2::jsonb ->> signal_type)::int,
              $3::int
            )
      ORDER BY COUNT(DISTINCT user_id) ASC
      LIMIT ${MAX_SHARED_SIGNAL_ROWS}`,
    [String(lookbackDays), JSON.stringify(MAX_USERS_PER_SIGNAL), DEFAULT_MAX_USERS_PER_SIGNAL]
  )
  return result.rows
}

/**
 * Detect near-simultaneous order flow across different users' accounts.
 *
 * Two phases so this stays off O(users²):
 *   1. bucket trades by (instrument, direction, 5s slot) and keep only buckets
 *      holding 2+ distinct users — cheap, and eliminates almost every pair
 *   2. score only those candidate pairs properly, with a real ±window
 *
 * Note trades has no user_id: ownership runs through accounts.
 */
async function detectSimultaneousExecution (windowHours = TRADE_WINDOW_HOURS) {
  const result = await pool.query(
    `SELECT a.user_id::text AS user_id,
            t.instrument,
            t.direction,
            t.open_time
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.open_time > NOW() - ($1 || ' hours')::interval
        AND t.open_time IS NOT NULL
        AND t.instrument IS NOT NULL
        AND t.direction IS NOT NULL
      ORDER BY t.open_time ASC
      LIMIT ${MAX_TRADE_ROWS}`,
    [String(windowHours)]
  )

  if (result.rows.length === 0) return []

  // Phase 1 — bucket for candidate generation.
  const byUser = new Map()
  const buckets = new Map()

  for (const row of result.rows) {
    const time = new Date(row.open_time).getTime()
    if (!Number.isFinite(time)) continue

    const trade = {
      time,
      instrument: String(row.instrument).toUpperCase(),
      direction: String(row.direction).toLowerCase()
    }

    if (!byUser.has(row.user_id)) byUser.set(row.user_id, [])
    byUser.get(row.user_id).push(trade)

    const slot = Math.floor(time / SIMULTANEITY_WINDOW_MS)
    const key = `${trade.instrument}|${trade.direction}|${slot}`
    if (!buckets.has(key)) buckets.set(key, new Set())
    buckets.get(key).add(row.user_id)
  }

  // Count co-occurrences so that if we have to truncate, we keep the strongest.
  const candidateCounts = new Map()
  for (const users of buckets.values()) {
    if (users.size < 2) continue
    const members = Array.from(users)
    for (const [a, b] of pairsFrom(members)) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      candidateCounts.set(key, (candidateCounts.get(key) || 0) + 1)
    }
  }

  const candidates = Array.from(candidateCounts.entries())
    .filter(([, count]) => count >= MIN_MATCHED_TRADES)
    .sort((x, y) => y[1] - x[1])
    .slice(0, MAX_CANDIDATE_PAIRS)

  // Phase 2 — proper scoring for surviving candidates only.
  const findings = []
  for (const [key] of candidates) {
    const [userA, userB] = key.split('|')
    const tradesA = byUser.get(userA) || []
    const tradesB = byUser.get(userB) || []
    const { overlap, matched } = overlapCoefficient(tradesA, tradesB)

    if (matched < MIN_MATCHED_TRADES) continue
    if (overlap < SIMULTANEITY_WEAK_THRESHOLD) continue

    findings.push({
      userA,
      userB,
      overlap: Number(overlap.toFixed(3)),
      matched,
      tradesA: tradesA.length,
      tradesB: tradesB.length
    })
  }

  return findings
}

/**
 * Active accounts for a set of users, so violations can be attached per account.
 */
async function fetchAccountsForUsers (userIds) {
  if (!userIds.length) return new Map()
  const result = await pool.query(
    `SELECT id::text AS id, user_id::text AS user_id
       FROM accounts
      WHERE user_id = ANY($1::uuid[])
        AND status = 'active'`,
    [userIds]
  )
  const byUser = new Map()
  for (const row of result.rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, [])
    byUser.get(row.user_id).push(row.id)
  }
  return byUser
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function persistCluster (cluster) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // status is deliberately NOT reset on conflict: an admin who already ruled
    // on this exact member set should not have that ruling undone by the next
    // scan. Membership is the cluster key, so a genuinely different ring gets a
    // different row. Mirrors the resolution_type handling in violationEngine.
    const upserted = await client.query(
      `INSERT INTO account_link_clusters
         (cluster_key, score, confidence, member_user_ids, member_count,
          signal_types, signal_summary, status, first_detected_at, last_detected_at)
       VALUES ($1, $2, $3, $4::uuid[], $5, $6::text[], $7::jsonb, 'open', NOW(), NOW())
       ON CONFLICT (cluster_key) DO UPDATE
         SET score            = EXCLUDED.score,
             confidence       = EXCLUDED.confidence,
             signal_types     = EXCLUDED.signal_types,
             signal_summary   = EXCLUDED.signal_summary,
             last_detected_at = NOW()
       RETURNING id, status`,
      [
        cluster.clusterKey,
        cluster.score,
        cluster.confidence,
        cluster.members,
        cluster.members.length,
        cluster.signalTypes,
        JSON.stringify(cluster.summary || {})
      ]
    )

    const clusterId = upserted.rows[0].id

    // Evidence is a full recomputation each scan, so replace rather than append.
    await client.query('DELETE FROM account_link_evidence WHERE cluster_id = $1', [clusterId])

    for (const item of cluster.evidence) {
      await client.query(
        `INSERT INTO account_link_evidence
           (cluster_id, evidence_type, evidence_value, evidence_label,
            user_ids, distinct_users, weight, detail, observed_at)
         VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8::jsonb, COALESCE($9, NOW()))`,
        [
          clusterId,
          item.type,
          item.value || null,
          item.label || null,
          item.userIds || [],
          item.distinctUsers || (item.userIds ? item.userIds.length : 0),
          Math.round(item.weight || 0),
          JSON.stringify(item.detail || {}),
          item.observedAt || null
        ]
      )
    }

    await client.query('COMMIT')
    return { id: clusterId, status: upserted.rows[0].status }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Raise a violation per member account so the finding shows up in the existing
 * AdminViolations queue, sidebar badge and admin_alert toasts.
 *
 * Deliberately does NOT call applyAccountEnforcement — this feature alerts, it
 * does not enforce.
 */
async function emitClusterViolations (cluster, clusterId) {
  const accountsByUser = await fetchAccountsForUsers(cluster.members)
  const severity = cluster.confidence === 'high' ? 'critical' : 'high'
  const topSignals = cluster.signalTypes.join(', ')

  for (const userId of cluster.members) {
    const accountIds = accountsByUser.get(userId) || []
    for (const accountId of accountIds) {
      try {
        await recordViolation({
          violationType: 'account_sharing_suspected',
          // Stable per (cluster, account) so re-scans increment hit_count
          // instead of creating a new violation every 15 minutes.
          dedupeKey: `account_sharing:${cluster.clusterKey}`,
          severity,
          accountId,
          userId,
          source: 'account_linking',
          message: `Possible account sharing: ${cluster.members.length} linked users (score ${cluster.score}/100, signals: ${topSignals})`,
          payload: {
            cluster_id: clusterId,
            cluster_key: cluster.clusterKey,
            score: cluster.score,
            confidence: cluster.confidence,
            member_user_ids: cluster.members,
            signal_types: cluster.signalTypes
          }
        })
      } catch (err) {
        logger.warn('[account_linking] Failed to record violation', {
          error: err.message, accountId, clusterId
        })
      }
    }
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Full detection pass. Safe to run concurrently across processes — the caller
 * wraps it in a Postgres advisory lock via runLockedSchedulerJob.
 */
async function runAccountLinkingScan (options = {}) {
  const lookbackDays = options.lookbackDays || SIGNAL_LOOKBACK_DAYS
  const windowHours = options.windowHours || TRADE_WINDOW_HOURS
  const startedAt = Date.now()

  try {
    const [sharedSignals, simultaneity] = await Promise.all([
      fetchSharedSignals(lookbackDays),
      detectSimultaneousExecution(windowHours)
    ])

    // Build the pair list that feeds Union-Find.
    const pairs = []
    for (const row of sharedSignals) {
      for (const pair of pairsFrom(row.user_ids.map(String))) pairs.push(pair)
    }
    for (const finding of simultaneity) {
      pairs.push([finding.userA, finding.userB])
    }

    const clusters = buildClusters(pairs)
    if (clusters.length === 0) {
      logger.info('[account_linking] Scan complete — no clusters', {
        durationMs: Date.now() - startedAt
      })
      return { clusters: 0, persisted: 0 }
    }

    // Index evidence by member so each cluster only walks its own.
    const memberIndex = new Map()
    for (const members of clusters) {
      for (const member of members) memberIndex.set(member, members)
    }

    const evidenceByCluster = new Map()
    function addEvidence (members, item) {
      const key = buildClusterKey(members)
      if (!evidenceByCluster.has(key)) evidenceByCluster.set(key, [])
      evidenceByCluster.get(key).push(item)
    }

    for (const row of sharedSignals) {
      const userIds = row.user_ids.map(String)
      const members = memberIndex.get(userIds[0])
      if (!members) continue

      const baseWeight = SIGNAL_WEIGHTS[row.signal_type] || 5
      const factor = entropyFactor(row.distinct_users)

      addEvidence(members, {
        type: row.signal_type,
        // The stored value is already a hash for payout/KYC signals, and an IP
        // or fingerprint otherwise. Safe to show an admin either way.
        value: row.signal_value,
        label: describeSignal(row.signal_type, row.signal_value),
        userIds,
        distinctUsers: row.distinct_users,
        weight: baseWeight * factor,
        detail: {
          base_weight: baseWeight,
          entropy_factor: Number(factor.toFixed(3)),
          distinct_users: row.distinct_users
        },
        observedAt: row.last_seen_at
      })
    }

    for (const finding of simultaneity) {
      const members = memberIndex.get(finding.userA)
      if (!members) continue

      const strong = finding.overlap >= SIMULTANEITY_STRONG_THRESHOLD
      addEvidence(members, {
        type: 'simultaneous_execution',
        value: `${finding.userA}|${finding.userB}`,
        label: `${Math.round(finding.overlap * 100)}% of orders placed within ${SIMULTANEITY_WINDOW_MS / 1000}s of each other (${finding.matched} matched)`,
        userIds: [finding.userA, finding.userB],
        distinctUsers: 2,
        weight: strong ? SIMULTANEITY_STRONG_WEIGHT : SIMULTANEITY_WEAK_WEIGHT,
        detail: finding
      })
    }

    let persisted = 0
    for (const members of clusters) {
      const clusterKey = buildClusterKey(members)
      const evidence = evidenceByCluster.get(clusterKey) || []
      if (evidence.length === 0) continue

      const { score, confidence } = scoreCluster(members.length, evidence)
      if (score < MIN_PERSISTED_SCORE) continue

      const signalTypes = Array.from(new Set(evidence.map(item => item.type))).sort()
      const cluster = {
        clusterKey,
        members,
        score,
        confidence,
        signalTypes,
        evidence,
        summary: {
          evidence_count: evidence.length,
          signal_types: signalTypes,
          top_signal: signalTypes[0] || null,
          scanned_at: new Date().toISOString()
        }
      }

      try {
        const { id, status } = await persistCluster(cluster)
        persisted += 1

        // Do not re-alert on something an admin already dismissed.
        if (score >= MIN_VIOLATION_SCORE && status === 'open') {
          await emitClusterViolations(cluster, id)
        }
      } catch (err) {
        logger.error('[account_linking] Failed to persist cluster', {
          error: err.message, clusterKey, members: members.length
        })
      }
    }

    logger.info('[account_linking] Scan complete', {
      sharedSignals: sharedSignals.length,
      simultaneityPairs: simultaneity.length,
      clusters: clusters.length,
      persisted,
      durationMs: Date.now() - startedAt
    })

    return { clusters: clusters.length, persisted }
  } catch (err) {
    logger.error('[account_linking] Scan failed', { error: err.message, stack: err.stack })
    return { clusters: 0, persisted: 0, error: err.message }
  }
}

function describeSignal (signalType, signalValue) {
  switch (signalType) {
    case SIGNAL_TYPES.IP:
      return `Same IP address (${signalValue})`
    case SIGNAL_TYPES.IP_SUBNET:
      return `Same network (${signalValue})`
    case SIGNAL_TYPES.DEVICE_FP:
      return 'Same device fingerprint'
    case SIGNAL_TYPES.DEVICE_COMPONENT:
      return `Same device component (${String(signalValue).split(':')[0]})`
    case SIGNAL_TYPES.PAYOUT_DEST:
      return 'Same payout destination'
    case SIGNAL_TYPES.KYC_DOC:
      return 'Same KYC document'
    default:
      return signalType
  }
}

/**
 * Retention prune. identity_signals is append-mostly and grows with every login
 * and trade; nothing older than the lookback window is ever read.
 */
async function pruneIdentitySignals (retentionDays = 180) {
  try {
    const result = await pool.query(
      `DELETE FROM identity_signals WHERE last_seen_at < NOW() - ($1 || ' days')::interval`,
      [String(retentionDays)]
    )
    if (result.rowCount > 0) {
      logger.info('[account_linking] Pruned identity signals', { removed: result.rowCount })
    }
  } catch (err) {
    logger.warn('[account_linking] Prune failed', { error: err.message })
  }
}

module.exports = {
  runAccountLinkingScan,
  pruneIdentitySignals,
  detectSimultaneousExecution,
  fetchSharedSignals,
  // Exported for tests
  buildClusters,
  buildClusterKey,
  entropyFactor,
  clusterSizeFactor,
  confidenceForScore,
  overlapCoefficient,
  scoreCluster,
  pairsFrom,
  SIMULTANEITY_WINDOW_MS,
  MIN_MATCHED_TRADES,
  MIN_PERSISTED_SCORE
}
