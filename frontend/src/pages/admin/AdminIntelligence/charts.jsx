import React, { useMemo, useState } from 'react';
import Card from '../../../components/ui/Card';
import { fmtNumber, fmtPct, fmtMoney, seriesColor } from './shared';

// Chart primitives recharts does not give us, drawn as inline SVG or CSS grid.
//
// All of them follow the same three rules as the recharts wrappers:
//   - every colour is an existing admin token, so light/dark needs no branches;
//   - numerals are tabular so columns of figures line up;
//   - a container that can overflow scrolls inside itself, never the page body.

// ── Heatmap ──────────────────────────────────────────────────────────────────
// A matrix of intensity cells (hour × weekday, violation type × severity).
// Intensity is expressed as opacity over a single token rather than a rainbow,
// which keeps it readable for colour-vision deficiency and in both themes.
export function Heatmap({ title, eyebrow, rows, columns, cells, valueLabel = 'value', formatValue = fmtNumber, colorFor }) {
  const [hover, setHover] = useState(null);

  const { lookup, max } = useMemo(() => {
    const map = new Map();
    let peak = 0;
    for (const cell of cells || []) {
      map.set(`${cell.row}|${cell.column}`, cell);
      peak = Math.max(peak, Math.abs(Number(cell.value) || 0));
    }
    return { lookup: map, max: peak };
  }, [cells]);

  if (!rows?.length || !columns?.length) {
    return <Card title={title} eyebrow={eyebrow}><p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No activity in this window.</p></Card>;
  }

  return (
    <Card title={title} eyebrow={eyebrow}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: '2px', minWidth: `${columns.length * 44 + 120}px` }}>
          <thead>
            <tr>
              <th aria-hidden="true" />
              {columns.map((col) => (
                <th key={col} scope="col" style={{
                  fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)',
                  color: 'var(--admin-text-faint)', fontWeight: 500,
                  textAlign: 'center', padding: '0 0 var(--space-1)', textTransform: 'uppercase'
                }}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row}>
                <th scope="row" style={{
                  fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)',
                  color: 'var(--admin-text-muted)', fontWeight: 500,
                  textAlign: 'right', paddingRight: 'var(--space-2)', whiteSpace: 'nowrap'
                }}>{row}</th>
                {columns.map((col) => {
                  const cell = lookup.get(`${row}|${col}`);
                  const value = Number(cell?.value) || 0;
                  const intensity = max > 0 ? Math.abs(value) / max : 0;
                  const base = colorFor ? colorFor(value) : 'var(--admin-accent)';
                  const key = `${row}|${col}`;
                  const isHover = hover === key;
                  return (
                    <td
                      key={col}
                      onMouseEnter={() => setHover(key)}
                      onMouseLeave={() => setHover(null)}
                      title={`${row} · ${col}: ${formatValue(value)} ${valueLabel}`}
                      style={{
                        width: '40px', height: '26px', borderRadius: '2px',
                        background: cell ? base : 'transparent',
                        opacity: cell ? Math.max(0.12, intensity) : 1,
                        border: isHover ? '1px solid var(--admin-text)' : '1px solid var(--rule)',
                        cursor: cell ? 'default' : 'default'
                      }}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hover && lookup.get(hover) ? (
        <p style={{ margin: 'var(--space-3) 0 0', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--admin-text)' }}>
          {hover.replace('|', ' · ')} — {formatValue(lookup.get(hover).value)} {valueLabel}
        </p>
      ) : (
        <p style={{ margin: 'var(--space-3) 0 0', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-faint)' }}>
          Hover a cell for its exact figure. Shade is relative to the busiest cell.
        </p>
      )}
    </Card>
  );
}

// ── Funnel ───────────────────────────────────────────────────────────────────
// Each stage's bar is scaled to the FIRST stage, and the step-to-step drop is
// labelled — a funnel that only shows absolute counts hides where people leave.
export function Funnel({ title, eyebrow, stages }) {
  const first = Number(stages?.[0]?.count) || 0;
  if (!stages?.length) {
    return <Card title={title} eyebrow={eyebrow}><p style={{ color: 'var(--admin-text-faint)', margin: 0 }}>No funnel events recorded.</p></Card>;
  }

  return (
    <Card title={title} eyebrow={eyebrow}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {stages.map((stage, index) => {
          const count = Number(stage.count) || 0;
          const width = first > 0 ? Math.max((count / first) * 100, count > 0 ? 2 : 0) : 0;
          const prev = index > 0 ? (Number(stages[index - 1].count) || 0) : null;
          const dropPct = prev && prev > 0 ? ((prev - count) / prev) * 100 : null;

          return (
            <div key={stage.stage}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--space-1)' }}>
                <span style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)', fontWeight: 600 }}>{stage.stage}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>
                  {fmtNumber(count)}
                  {first > 0 && (
                    <span style={{ color: 'var(--admin-text-faint)', marginLeft: 'var(--space-2)', fontSize: 'var(--fs-sm)' }}>
                      {fmtPct((count / first) * 100)}
                    </span>
                  )}
                </span>
              </div>
              <div style={{ height: '22px', background: 'var(--glass-1, transparent)', border: '1px solid var(--rule)', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ width: `${width}%`, height: '100%', background: seriesColor(index), opacity: 0.75, transition: 'width .3s ease' }} />
              </div>
              {dropPct !== null && dropPct > 0 ? (
                <div style={{ fontSize: 'var(--fs-3xs)', fontFamily: 'var(--font-mono)', color: 'var(--admin-danger)', marginTop: 'var(--space-1)', letterSpacing: '.05em' }}>
                  ↓ {fmtPct(dropPct)} drop from previous stage
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Survival curve ───────────────────────────────────────────────────────────
// One polyline per model over the day axis. Drawn by hand rather than with
// recharts because each series has its own x-domain (models are only plotted
// out to the day where they still have accounts at risk).
export function SurvivalCurve({ title, eyebrow, models, height = 260 }) {
  const width = 620;
  const pad = { top: 12, right: 16, bottom: 28, left: 40 };
  const plotted = (models || []).filter((m) => m.points?.some((p) => p.alive_pct !== null)).slice(0, 6);

  if (!plotted.length) {
    return <Card title={title} eyebrow={eyebrow}><p style={{ color: 'var(--admin-text-faint)', margin: 0 }}>Not enough resolved accounts to draw a survival curve.</p></Card>;
  }

  const days = plotted[0].points.map((p) => p.day);
  const maxDay = Math.max(...days);
  const x = (day) => pad.left + ((day / maxDay) * (width - pad.left - pad.right));
  const y = (pctAlive) => pad.top + ((100 - pctAlive) / 100) * (height - pad.top - pad.bottom);

  return (
    <Card title={title} eyebrow={eyebrow}>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
          aria-label={`Account survival by day for ${plotted.map((m) => m.model_slug).join(', ')}`}>
          {[0, 25, 50, 75, 100].map((tick) => (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)}
                stroke="var(--rule)" strokeDasharray="3 3" />
              <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end"
                fill="var(--admin-text-faint)" fontSize="10" fontFamily="var(--font-mono)">{tick}%</text>
            </g>
          ))}
          {days.map((day) => (
            <text key={day} x={x(day)} y={height - pad.bottom + 16} textAnchor="middle"
              fill="var(--admin-text-faint)" fontSize="10" fontFamily="var(--font-mono)">{day}</text>
          ))}
          <text x={width / 2} y={height - 4} textAnchor="middle" fill="var(--admin-text-muted)" fontSize="10">
            Days since account created
          </text>
          {plotted.map((model, index) => {
            const points = model.points.filter((p) => p.alive_pct !== null);
            if (points.length < 2) return null;
            const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.day)} ${y(p.alive_pct)}`).join(' ');
            return (
              <g key={model.model_slug}>
                <path d={d} fill="none" stroke={seriesColor(index)} strokeWidth="2" strokeLinejoin="round" />
                {points.map((p) => (
                  <circle key={p.day} cx={x(p.day)} cy={y(p.alive_pct)} r="2.5" fill={seriesColor(index)}>
                    <title>{`${model.model_slug} · day ${p.day}: ${fmtPct(p.alive_pct)} alive of ${p.at_risk} at risk`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        {plotted.map((model, index) => (
          <span key={model.model_slug} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
            <span style={{ width: '12px', height: '3px', background: seriesColor(index), display: 'inline-block' }} />
            {model.model_slug} <span style={{ color: 'var(--admin-text-faint)' }}>({model.accounts})</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

// ── Ranked geography ─────────────────────────────────────────────────────────
// A ranked bar list rather than a world map: a choropleth needs boundary data
// this app does not ship, and a ranked list answers "where is the money coming
// from" more directly anyway.
export function GeoRanking({ title, eyebrow, rows, limit = 12 }) {
  const shown = (rows || []).slice(0, limit);
  const max = Math.max(...shown.map((r) => Number(r.revenue) || 0), 1);

  if (!shown.length) {
    return <Card title={title} eyebrow={eyebrow}><p style={{ color: 'var(--admin-text-faint)', margin: 0 }}>No signups in this window.</p></Card>;
  }

  return (
    <Card title={title} eyebrow={eyebrow}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2-5)' }}>
        {shown.map((row) => (
          <div key={row.country}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-3)' }}>
              <span style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>{row.country}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)', whiteSpace: 'nowrap' }}>
                {fmtMoney(row.revenue)} · {fmtNumber(row.signups)} signups · {fmtPct(row.pass_rate_pct)} pass
              </span>
            </div>
            <div style={{ height: '6px', background: 'var(--rule)', borderRadius: '3px', overflow: 'hidden', marginTop: 'var(--space-1)' }}>
              <div style={{ width: `${((Number(row.revenue) || 0) / max) * 100}%`, height: '100%', background: 'var(--admin-accent)', opacity: 0.8 }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Horizontal comparison bar ────────────────────────────────────────────────
// Two values against each other (trader vs peer, referred vs organic). Renders
// the gap explicitly, since that is the actual finding.
export function Versus({ label, left, right, leftLabel, rightLabel, format = fmtNumber }) {
  const l = Number(left) || 0;
  const r = Number(right) || 0;
  const total = Math.abs(l) + Math.abs(r);
  const leftShare = total > 0 ? (Math.abs(l) / total) * 100 : 50;

  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)', marginBottom: 'var(--space-1)' }}>
        <span>{label}</span>
      </div>
      <div style={{ display: 'flex', height: '24px', border: '1px solid var(--rule)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ width: `${leftShare}%`, background: 'var(--admin-accent)', opacity: 0.75 }} />
        <div style={{ width: `${100 - leftShare}%`, background: 'var(--admin-text-faint)', opacity: 0.4 }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-1)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--fs-sm)' }}>
        <span style={{ color: 'var(--admin-accent)' }}>{leftLabel} {format(left)}</span>
        <span style={{ color: 'var(--admin-text-muted)' }}>{rightLabel} {format(right)}</span>
      </div>
    </div>
  );
}

// ── Progress meter ───────────────────────────────────────────────────────────
// Used wherever a value sits against a hard limit (drawdown allowance consumed,
// target progress). Tone shifts as the value approaches the limit.
export function Meter({ label, value, max = 100, tone, caption }) {
  const pct = max > 0 ? Math.min((Number(value) / max) * 100, 100) : 0;
  const autoTone = pct >= 85 ? 'var(--admin-danger)' : pct >= 60 ? 'var(--admin-warning)' : 'var(--admin-success)';

  return (
    <div style={{ marginBottom: 'var(--space-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--space-1)' }}>
        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--fs-base)', color: tone || autoTone, fontWeight: 600 }}>
          {fmtPct(value)}
        </span>
      </div>
      <div style={{ height: '8px', background: 'var(--rule)', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: tone || autoTone, transition: 'width .3s ease' }} />
      </div>
      {caption ? <div style={{ fontSize: 'var(--fs-3xs)', color: 'var(--admin-text-faint)', marginTop: 'var(--space-1)' }}>{caption}</div> : null}
    </div>
  );
}
