import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminStatCard from '../../components/admin/AdminStatCard';
import Card from '../../components/ui/Card';

// Live view of GET /api/admin/system-health. The endpoint already rolls each
// subsystem up to ok / warn / error, so this page's job is to render that
// faithfully and keep a short rolling history for the sparklines — no
// thresholds are re-derived here, or the two would drift.

const POLL_MS = 10_000;
const HISTORY_LIMIT = 60; // ~10 minutes at the poll interval

const SECTION_LABELS = {
  database: 'Database',
  redis: 'Redis',
  priceFeed: 'Price Feed',
  tradeEngine: 'Trade Engine',
  emailQueue: 'Email Queue',
  websocket: 'WebSocket',
  process: 'Process'
};

function statusTone(status) {
  if (status === 'ok') return 'success';
  if (status === 'warn') return 'warning';
  if (status === 'error') return 'danger';
  return 'neutral';
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
}

/** Rows rendered per section. Keeps the JSX below flat and declarative. */
function sectionRows(key, data) {
  if (!data) return [];
  switch (key) {
    case 'database':
      return [
        ['Pool in use', `${data.total ?? '—'} / ${data.max ?? '—'}`],
        ['Idle', data.idle ?? '—'],
        ['Waiting', data.waiting ?? '—'],
        ['Ping', formatMs(data.latencyMs)]
      ];
    case 'redis':
      return [
        ['Connected', data.connected ? 'yes' : 'no'],
        ['Note', data.note || (data.error ? `error: ${data.error}` : '—')]
      ];
    case 'priceFeed':
      return [
        ['Last tick', formatMs(data.ageMs)],
        ['Has prices', data.hasPrices ? 'yes' : 'no'],
        ['Stale', data.stale ? 'yes' : 'no']
      ];
    case 'tradeEngine':
      return [
        ['Mode', data.mode || '—'],
        ['Index ready', data.ready ? 'yes' : 'no'],
        ['Open trades', data.openTrades ?? '—'],
        ['Pending orders', data.pendingOrders ?? '—'],
        ['Accounts', data.accounts ?? '—'],
        ['Last reconcile', formatMs(data.sinceReconcileMs)]
      ];
    case 'emailQueue':
      return [
        ['Pending', data.pending ?? 0],
        ['Retrying', data.retrying ?? 0],
        ['Dead (24h)', data.dead_last_24h ?? 0],
        ['Dead (total)', data.dead_count ?? 0],
        ['Last sent', formatTime(data.lastSentAt)]
      ];
    case 'websocket':
      return [['Connected clients', data.connected ?? (data.note || '—')]];
    case 'process':
      return [
        ['Uptime', formatUptime(data.uptimeSeconds)],
        ['Heap', `${data.heapUsedMb ?? '—'} / ${data.heapTotalMb ?? '—'} MB (${data.heapUsedPct ?? '—'}%)`],
        ['RSS', `${data.rssMb ?? '—'} MB`],
        ['Node', data.nodeVersion || '—']
      ];
    default:
      return [];
  }
}

function Sparkline({ points, max }) {
  if (!points || points.length < 2) return null;
  const ceiling = Math.max(max || 0, ...points, 1);
  const width = 120;
  const height = 28;
  const step = width / (points.length - 1);
  const path = points
    .map((value, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - (value / ceiling) * height).toFixed(1)}`)
    .join(' ');

  return (
    <svg width={width} height={height} role="img" aria-label="recent trend" style={{ display: 'block' }}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.75" />
    </svg>
  );
}

export default function AdminSystemHealth() {
  const { adminAxios } = useOutletContext();
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [history, setHistory] = useState({ poolWaiting: [], openTrades: [], emailPending: [], sockets: [] });
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await adminAxios.get('/api/admin/system-health');
      setHealth(res.data);
      setError('');
      setLastUpdated(new Date());

      const s = res.data?.sections || {};
      setHistory((prev) => {
        const push = (arr, value) => [...arr, Number(value) || 0].slice(-HISTORY_LIMIT);
        return {
          poolWaiting: push(prev.poolWaiting, s.database?.waiting),
          openTrades: push(prev.openTrades, s.tradeEngine?.openTrades),
          emailPending: push(prev.emailPending, s.emailQueue?.pending),
          sockets: push(prev.sockets, s.websocket?.connected)
        };
      });
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load system health.');
    } finally {
      setLoading(false);
    }
  }, [adminAxios]);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  useEffect(() => {
    document.title = 'System Health | Admin';
  }, []);

  const sections = health?.sections || {};
  const degraded = Object.entries(sections).filter(([, data]) => data?.status === 'warn' || data?.status === 'error');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>System Health</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)' }}>
            Refreshes every {POLL_MS / 1000}s
            {lastUpdated ? ` · last updated ${lastUpdated.toLocaleTimeString()}` : ''}
          </p>
        </div>
        {health?.status ? (
          <AdminBadge tone={statusTone(health.status)}>
            {health.status === 'ok' ? 'All systems normal' : `Degraded: ${health.status}`}
          </AdminBadge>
        ) : null}
      </div>

      {error ? (
        <Card style={{ padding: 'var(--space-4)', marginBottom: 'var(--space-4)', borderColor: 'var(--admin-danger, #b3261e)' }}>
          <strong>{error}</strong>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', marginTop: 'var(--space-1)' }}>
            Showing the last successful reading, if any.
          </div>
        </Card>
      ) : null}

      {loading && !health ? <Card style={{ padding: 'var(--space-6)' }}>Loading system health…</Card> : null}

      {degraded.length > 0 ? (
        <Card style={{ padding: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
          <strong>Attention needed</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 'var(--space-5)' }}>
            {degraded.map(([key, data]) => (
              <li key={key} style={{ fontSize: 'var(--fs-base)' }}>
                {SECTION_LABELS[key] || key}: {data.status}
                {data.error ? ` — ${data.error}` : ''}
                {data.note ? ` — ${data.note}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {health ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
          <AdminStatCard label="Open trades" value={sections.tradeEngine?.openTrades ?? '—'} />
          <AdminStatCard label="Connected clients" value={sections.websocket?.connected ?? '—'} />
          <AdminStatCard label="Pool waiting" value={sections.database?.waiting ?? '—'} />
          <AdminStatCard label="Dead emails (24h)" value={sections.emailQueue?.dead_last_24h ?? '—'} />
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--space-4)' }}>
        {Object.keys(SECTION_LABELS).map((key) => {
          const data = sections[key];
          if (!data) return null;
          const trend = key === 'database' ? history.poolWaiting
            : key === 'tradeEngine' ? history.openTrades
              : key === 'emailQueue' ? history.emailPending
                : key === 'websocket' ? history.sockets
                  : null;

          return (
            <Card key={key} style={{ padding: 'var(--space-4)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
                <strong>{SECTION_LABELS[key]}</strong>
                <AdminBadge tone={statusTone(data.status)}>{data.status}</AdminBadge>
              </div>

              <table style={{ width: '100%', fontSize: 'var(--fs-base)', borderCollapse: 'collapse' }}>
                <tbody>
                  {sectionRows(key, data).map(([label, value]) => (
                    <tr key={label}>
                      <td style={{ padding: '3px 0', color: 'var(--admin-text-faint)' }}>{label}</td>
                      <td style={{ padding: '3px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{String(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {trend && trend.length > 1 ? (
                <div style={{ marginTop: 'var(--space-3)', color: 'var(--admin-accent, #6b7bff)' }}>
                  <Sparkline points={trend} />
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
