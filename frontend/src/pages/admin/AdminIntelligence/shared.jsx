import React, { useEffect, useState } from 'react';
import Card from '../../../components/ui/Card';
import { SkeletonCard, SkeletonStats } from '../../../components/ui/Skeleton';

// Shared plumbing for both intelligence pages.
//
// Everything here is presentation or fetching — there is no mutation helper in
// this file, and there must never be one. Both pages are strictly read-only.

// ── Formatting ───────────────────────────────────────────────────────────────
// A null from the API means "we could not compute this", which is different
// from zero. Every formatter renders that as an em dash rather than 0, so an
// operator can always tell a real zero from an absent answer.
const EMPTY = '—';

export function fmtMoney(value, { decimals = 0, signed = false } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return EMPTY;
  const n = Number(value);
  const body = `$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}`;
  if (n < 0) return `-${body}`;
  return signed ? `+${body}` : body;
}

export function fmtNumber(value, decimals = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return EMPTY;
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function fmtPct(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return EMPTY;
  return `${Number(value).toFixed(decimals)}%`;
}

export function fmtDate(value) {
  if (!value) return EMPTY;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? EMPTY : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(value) {
  if (!value) return EMPTY;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? EMPTY : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return EMPTY;
  const m = Number(minutes);
  if (m < 1) return `${Math.round(m * 60)}s`;
  if (m < 60) return `${m.toFixed(0)}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}

export function toneFor(value) {
  if (value === null || value === undefined) return 'var(--admin-text-muted)';
  return Number(value) >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)';
}

// ── Chart palette ────────────────────────────────────────────────────────────
// Every colour is an existing admin token, so both pages track the viewer's
// light/dark theme with no per-chart overrides. Ordered so adjacent series in a
// stack stay distinguishable.
export const SERIES = [
  'var(--admin-accent)',
  'var(--admin-success)',
  'var(--admin-warning)',
  'var(--admin-danger)',
  'var(--admin-text-muted)',
  'var(--accent-2, var(--admin-accent))'
];

export function seriesColor(index) {
  return SERIES[index % SERIES.length];
}

// ── Data fetching ────────────────────────────────────────────────────────────
// One hook for every tab. Polls on an interval so the page is genuinely live
// without a websocket, and reports the last successful refresh so an operator
// can see the data is moving.
export function useIntelligence(adminAxios, path, { params = null, intervalMs = 60000 } = {}) {
  const [state, setState] = useState({ data: null, loading: true, error: null, updatedAt: null });
  // Serialised so a fresh object literal from the caller does not restart the
  // poll on every parent render.
  const paramKey = params ? JSON.stringify(params) : '';

  useEffect(() => {
    let cancelled = false;
    const query = paramKey ? JSON.parse(paramKey) : null;

    // Declared inside the effect so it is not a render-scope dependency —
    // matching the fetch pattern the existing analytics tabs already use.
    const fetchOnce = async (silent) => {
      if (!silent) setState((prev) => ({ ...prev, loading: true }));
      try {
        const res = await adminAxios.get(path, query ? { params: query } : undefined);
        if (cancelled) return;
        setState({ data: res.data, loading: false, error: null, updatedAt: new Date() });
      } catch (err) {
        if (cancelled) return;
        // A silent background refresh that fails leaves the last good payload
        // on screen rather than blanking a dashboard someone is reading.
        if (silent) return;
        setState({
          data: null,
          loading: false,
          error: err?.response?.data?.error || 'Could not load this view',
          updatedAt: null
        });
      }
    };

    fetchOnce(false);
    const id = intervalMs > 0 ? setInterval(() => fetchOnce(true), intervalMs) : null;
    return () => { cancelled = true; if (id) clearInterval(id); };
  }, [adminAxios, path, paramKey, intervalMs]);

  return state;
}

// ── Shared chrome ────────────────────────────────────────────────────────────
export function TabLoading({ stats = 4 }) {
  return (
    <div aria-busy="true">
      <span className="ui-skeleton-srlabel">Loading analytics</span>
      <SkeletonStats count={stats} />
      <SkeletonCard lines={3} height={280} style={{ marginBottom: 'var(--space-4)' }} />
      <SkeletonCard lines={3} height={240} />
    </div>
  );
}

export function TabError({ message }) {
  return (
    <Card style={{ textAlign: 'center', padding: 'var(--space-9)' }}>
      <h3 style={{ color: 'var(--admin-danger)', marginBottom: 'var(--space-2)' }}>Could not load this view</h3>
      <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', margin: 0 }}>{message}</p>
    </Card>
  );
}

// Renders where a metric exists but the data to answer it does not. Deliberately
// distinct from an empty chart: "we never collected this" and "this is zero" are
// different facts and must not look the same.
export function NeedsData({ title, reason }) {
  return (
    <Card title={title}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        padding: 'var(--space-4)', border: '1px dashed var(--rule)',
        borderRadius: 'var(--radius-sm)', color: 'var(--admin-text-muted)',
        fontSize: 'var(--fs-base)', lineHeight: 1.5
      }}>
        <span aria-hidden="true" style={{ fontSize: 'var(--fs-xl)', opacity: 0.6 }}>◌</span>
        <span>{reason}</span>
      </div>
    </Card>
  );
}

export function SectionNote({ children }) {
  if (!children) return null;
  return (
    <p style={{
      color: 'var(--admin-text-faint)', fontSize: 'var(--fs-sm)',
      margin: 'var(--space-2) 0 0', lineHeight: 1.5, fontStyle: 'italic'
    }}>
      {children}
    </p>
  );
}

export function ChartGrid({ children, min = 380 }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
      gap: 'var(--space-4)',
      marginBottom: 'var(--space-6)'
    }}>
      {children}
    </div>
  );
}

export function SectionHeading({ children, action }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      gap: 'var(--space-3)', margin: 'var(--space-6) 0 var(--space-3)', flexWrap: 'wrap'
    }}>
      <h2 className="admin-h2" style={{ margin: 0 }}>{children}</h2>
      {action}
    </div>
  );
}

// A compact label/value pair for dense metric blocks that do not warrant a card.
export function MetricRow({ label, value, tone, mono = true }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 'var(--space-3)', padding: 'var(--space-2) 0',
      borderBottom: '1px solid var(--rule)'
    }}>
      <span style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)' }}>{label}</span>
      <span style={{
        fontFamily: mono ? 'var(--font-mono)' : undefined,
        fontVariantNumeric: 'tabular-nums',
        color: tone || 'var(--admin-text)',
        fontWeight: 600,
        fontSize: 'var(--fs-base)'
      }}>{value}</span>
    </div>
  );
}

export function LastUpdated({ at, intervalMs }) {
  if (!at) return null;
  const seconds = Math.round((intervalMs || 60000) / 1000);
  return (
    <span style={{
      fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)',
      letterSpacing: '.08em', textTransform: 'uppercase',
      color: 'var(--admin-text-faint)'
    }}>
      Live · updated {at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · every {seconds}s
    </span>
  );
}
