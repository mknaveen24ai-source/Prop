import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { renderIcon } from '../utils/iconMap'
import { buildRuleColumns, PhaseTable } from './ChallengeRules'

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC RULEBOOK — /rules
//
// The in-app rulebook (ChallengeRules.jsx) is account-scoped: it needs a
// selected account before it can describe anything, and it lives inside the
// authenticated dashboard. That meant the full rule set could not be read until
// AFTER a trader had paid, while the landing page advertised "no hidden rules".
//
// This page renders the same rules from the same builders, driven by a model
// picker instead of an account. buildRuleColumns() and PhaseTable() are
// imported rather than reimplemented so the public page and the in-app page
// cannot drift into describing the same rule two different ways.
// ─────────────────────────────────────────────────────────────────────────────

// buildRuleColumns() expects the shape the authenticated /rules endpoint
// returns. Public visitors have no account, so the phase-dependent numbers come
// from the selected model + step and the rest from platform settings.
function synthesiseRules(platform, model, stepIndex, viewingFunded) {
  if (!platform || !model) return null
  const targets = Array.isArray(model.profit_targets_pct) ? model.profit_targets_pct : [model.profit_targets_pct]
  const limits = Array.isArray(model.time_limits_days) ? model.time_limits_days : [model.time_limits_days]

  return {
    ...platform,
    profit_target_pct: viewingFunded ? 0 : Number(targets[stepIndex] ?? targets[0] ?? 0),
    // No account, so no dollar figure — the percentage carries the rule.
    profit_target_amount: 0,
    time_limit_days: viewingFunded ? null : Number(limits[stepIndex] ?? limits[0] ?? 0),
    max_drawdown_pct: viewingFunded ? Number(model.funded_max_drawdown_pct) : Number(model.max_drawdown_pct),
    daily_drawdown_pct: viewingFunded ? Number(model.funded_daily_drawdown_pct) : Number(model.daily_drawdown_pct),
  }
}

function PassRateBadge({ stats }) {
  if (!stats) return null
  const hasData = stats.pass_rate != null && stats.finished > 0
  return (
    <div
      style={{
        border: '1px solid var(--rule)', background: 'var(--glass)', padding: 'var(--space-4) var(--space-5)',
        display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-4)',
      }}
    >
      <div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          Pass rate
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-5xl)', fontWeight: 700, color: 'var(--ink)', lineHeight: 1.1 }}>
          {hasData ? `${stats.pass_rate}%` : '—'}
        </div>
      </div>
      <p style={{ flex: 1, minWidth: '240px', fontSize: 'var(--fs-base)', color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
        {hasData
          ? `${stats.funded.toLocaleString()} of ${stats.finished.toLocaleString()} finished evaluations on this model reached a funded account. Challenges still in progress are excluded from both sides of that figure.`
          : 'No evaluation on this model has finished yet. We publish this number as soon as there is one to publish — including if it is a number we would rather not show.'}
      </p>
    </div>
  )
}

export default function PublicRules() {
  const [data, setData] = useState(null)
  const [passRates, setPassRates] = useState(null)
  const [error, setError] = useState('')
  const [slug, setSlug] = useState(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [viewingFunded, setViewingFunded] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.get('/api/accounts/step-models-public', { skipAuthRedirect: true })
      .then((res) => {
        if (cancelled) return
        setData(res.data)
        setSlug(res.data?.models?.[0]?.slug || null)
      })
      .catch(() => { if (!cancelled) setError('Could not load the rulebook. Please refresh.') })

    api.get('/api/transparency/pass-rates', { skipAuthRedirect: true })
      .then((res) => { if (!cancelled) setPassRates(res.data) })
      .catch(() => { /* pass rates are additive — the rulebook still renders */ })

    return () => { cancelled = true }
  }, [])

  const models = useMemo(() => data?.models || [], [data?.models])
  const model = useMemo(() => models.find((m) => m.slug === slug) || models[0] || null, [models, slug])
  const stepCount = model?.steps || 1

  const rules = useMemo(
    () => synthesiseRules(data?.platform, model, stepIndex, viewingFunded),
    [data, model, stepIndex, viewingFunded]
  )

  const ruleColumns = useMemo(
    () => (rules && model
      ? buildRuleColumns(rules, {
          isFundedAccount: viewingFunded,
          currentModel: model,
          currentStepNumber: stepIndex + 1,
        })
      : []),
    [rules, model, viewingFunded, stepIndex]
  )

  const modelStats = passRates?.models?.find((m) => m.slug === model?.slug) || null

  if (error) {
    return <div style={{ maxWidth: '1080px', margin: '0 auto', padding: 'var(--space-9) var(--space-5)' }}><p style={{ color: 'var(--loss)' }}>{error}</p></div>
  }
  if (!model || !rules) {
    return <div style={{ maxWidth: '1080px', margin: '0 auto', padding: 'var(--space-9) var(--space-5)' }}><p style={{ color: 'var(--muted)' }}>Loading the rulebook…</p></div>
  }

  const stageChips = [
    ...Array.from({ length: stepCount }, (_, i) => ({ key: `step-${i}`, label: `Step ${i + 1}`, funded: false, index: i })),
    { key: 'funded', label: 'Funded', funded: true, index: 0 },
  ]

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', padding: 'var(--space-9) var(--space-5) var(--space-10)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>

      <header style={{ borderBottom: '3px double var(--ink)', paddingBottom: 'var(--space-4)' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--accent)' }}>
          The Rulebook · Public
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-7xl)', fontWeight: 400, margin: 'var(--space-2-5) 0 0', textWrap: 'balance' }}>
          Every rule, before you pay.
        </h1>
        <p style={{ fontSize: 'var(--fs-md)', lineHeight: 1.7, color: 'var(--muted)', maxWidth: '64ch', margin: 'var(--space-3) 0 0' }}>
          Everything that can end an account is printed on this page, read live from the platform&apos;s own settings — not
          a marketing summary of them. Nothing is held in a separate schedule, and nothing changes while a challenge is running.
        </p>
      </header>

      {/* Model picker */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {models.map((m) => (
          <button
            key={m.slug}
            type="button"
            onClick={() => { setSlug(m.slug); setStepIndex(0); setViewingFunded(false) }}
            style={{
              padding: 'var(--space-2) var(--space-4)', cursor: 'pointer',
              border: `1px solid ${m.slug === model.slug ? 'var(--accent)' : 'var(--rule)'}`,
              background: m.slug === model.slug ? 'var(--accent)' : 'transparent',
              color: m.slug === model.slug ? 'var(--paper)' : 'var(--text)',
              fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', letterSpacing: '.06em', textTransform: 'uppercase',
            }}
          >
            {m.name}
          </button>
        ))}
      </div>

      <PassRateBadge stats={modelStats} />

      {/* Stage picker */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          Viewing
        </span>
        {stageChips.map((chip) => {
          const active = chip.funded === viewingFunded && (chip.funded || chip.index === stepIndex)
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => { setViewingFunded(chip.funded); setStepIndex(chip.index) }}
              style={{
                padding: 'var(--space-1-5) var(--space-3)', cursor: 'pointer',
                border: `1px solid ${active ? 'var(--ink)' : 'var(--rule)'}`,
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--paper)' : 'var(--muted)',
                fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)',
              }}
            >
              {chip.label}
            </button>
          )
        })}
      </div>

      {/* Rule columns — identical builder to the in-app rulebook */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', border: '1px solid var(--rule)', background: 'var(--glass)' }}>
        {ruleColumns.map((col, colIndex) => (
          <div key={col.title} style={{ padding: 'var(--space-4-5) var(--space-5) var(--space-2)', borderRight: colIndex < ruleColumns.length - 1 ? '1px solid var(--rule)' : 'none' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-3xl)', borderBottom: '1px solid var(--rule)', paddingBottom: 'var(--space-3)', marginBottom: 'var(--space-1)' }}>
              {col.title}
            </div>
            {col.items.map((item) => (
              <div key={item.title} style={{ display: 'flex', gap: 'var(--space-3)', padding: 'var(--space-3) 0', borderBottom: '1px solid var(--rule-soft)' }}>
                <span style={{ display: 'inline-flex', color: item.tone, marginTop: 'var(--space-1)' }}>
                  {renderIcon(item.icon, { size: 15, color: item.tone })}
                </span>
                <div>
                  <div style={{ fontSize: 'var(--fs-base)' }}>{item.title}</div>
                  <div style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.62, color: 'var(--muted)', marginTop: 'var(--space-1)' }}>{item.body}</div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Targets by phase, every model */}
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-2xl)', borderBottom: '3px double var(--rule)', paddingBottom: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
          Targets by phase
        </div>
        {models.map((m) => (
          <PhaseTable
            key={m.slug}
            model={m}
            currentStepNumber={stepIndex + 1}
            isFundedAccount={viewingFunded}
            isCurrentModel={m.slug === model.slug}
          />
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--rule)' }}>
        <Link to="/register" className="btn btn-primary">Start an evaluation</Link>
        <Link to="/transparency" style={{ alignSelf: 'center', color: 'var(--accent)', fontSize: 'var(--fs-base)' }}>
          See our published payout and pass-rate data →
        </Link>
      </div>
    </div>
  )
}
