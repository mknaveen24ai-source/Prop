import React from 'react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { formatCurrency } from '../utils/finance'
import { useIsMobile } from '../hooks/useBreakpoint'

function formatCompact(value) {
  const n = Number(value || 0)
  const abs = Math.abs(n)
  if (abs >= 1000) return (n / 1000).toFixed(abs >= 100000 ? 0 : 1) + 'k'
  return String(Math.round(n))
}

/**
 * Balance & equity curve — the dashboard's flagship "never blank" chart
 * (Modern Gazette handoff spec: crosshair + dot + sticky tooltip anchored
 * to the hovered point; with no hover it pins to the last point instead
 * of disappearing). Recharts' Tooltip `defaultIndex` gives us that pin
 * for free — the same "last point sticks" contract PriceChart.jsx
 * implements by hand for the candlestick chart.
 */
function EquityTooltip({ active, payload, label, tone }) {
  if (!active || !payload || !payload.length) return null
  return (
    <div
      style={{
        background: 'var(--glass-2)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid ${tone}`,
        borderRadius: 'var(--radius-sm)',
        padding: '7px 10px',
        boxShadow: 'var(--elev)',
      }}
    >
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', color: 'var(--ink)', marginTop: 2 }}>
        {formatCurrency(payload[0].value)}
      </div>
    </div>
  )
}

export default function EquityCurveChart({ data, height = 240, tone }) {
  const isMobile = useIsMobile()
  if (!data || !data.length) return null

  const first = data[0].value
  const last = data[data.length - 1].value
  const resolvedTone = tone || (last >= first ? 'var(--gain)' : 'var(--loss)')
  const gradId = 'equity-curve-fill'

  return (
    // initialDimension overrides ResponsiveContainer's -1x-1 default, which
    // otherwise logs "The width(-1) and height(-1) of chart should be greater
    // than 0" on the frame before ResizeObserver reports the real width.
    <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 600, height }}>
      <AreaChart data={data} margin={{ top: 10, right: 12, bottom: 4, left: 4 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={resolvedTone} stopOpacity={0.3} />
            <stop offset="70%" stopColor={resolvedTone} stopOpacity={0.04} />
            <stop offset="100%" stopColor={resolvedTone} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--rule-soft)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 9.5, fill: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
          axisLine={{ stroke: 'var(--rule)' }}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis
          tick={{ fontSize: 9.5, fill: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={formatCompact}
          // 64px of axis gutter is ~19% of the plot area at a 335px content
          // width, which squeezes the curve itself into a strip. The labels are
          // already compact ("12.4k"), so a narrower gutter still fits them.
          width={isMobile ? 40 : 64}
        />
        <Tooltip
          defaultIndex={data.length - 1}
          cursor={{ stroke: resolvedTone, strokeDasharray: '3 3' }}
          content={<EquityTooltip tone={resolvedTone} />}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={resolvedTone}
          strokeWidth={1.9}
          fill={`url(#${gradId})`}
          dot={false}
          activeDot={{ r: 4.5, fill: 'var(--paper)', stroke: resolvedTone, strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
