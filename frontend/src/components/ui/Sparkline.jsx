import React from 'react'
import { AreaChart, Area, YAxis, ResponsiveContainer } from 'recharts'

/**
 * Sparkline chart contract (Modern Gazette handoff spec): ~100x34, 1.6px
 * stroke, 12% fill, an end dot marking the last value, no axes, no labels,
 * no interaction — decorative only, every stat card / table row.
 */
export default function Sparkline({ data, dataKey = 'value', width = 100, height = 34, tone = 'var(--muted)' }) {
  const lastIndex = Array.isArray(data) ? data.length - 1 : -1
  if (!Array.isArray(data) || data.length < 2) return <div style={{ width, height }} />

  // ResponsiveContainer starts at -1x-1 and only learns its real size once
  // ResizeObserver fires, logging "The width(-1) and height(-1) of chart
  // should be greater than 0" on that first frame — once per instance, and
  // the trading watchlist renders one of these per row. Callers that pass
  // pixel sizes (everything except the admin entity drawer) don't need
  // measuring at all, so draw at the known size and skip the observer.
  const fixed = typeof width === 'number' && typeof height === 'number'

  const chart = (
    <AreaChart
      data={data}
      margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
      {...(fixed ? { width, height } : null)}
    >
      <YAxis domain={['dataMin', 'dataMax']} hide />
      <Area
        type="monotone"
        dataKey={dataKey}
        stroke={tone}
        strokeWidth={1.6}
        fill={tone}
        fillOpacity={0.12}
        isAnimationActive={false}
        activeDot={false}
        dot={(props) => {
          if (props.index !== lastIndex) return null
          return <circle key={`sp-dot-${props.index}`} cx={props.cx} cy={props.cy} r={2} fill={tone} stroke="none" />
        }}
      />
    </AreaChart>
  )

  return (
    <div style={{ width, height }}>
      {fixed ? chart : (
        // Percentage width still has to be measured, but seeding the first
        // frame keeps it out of the warning path too.
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 100, height: typeof height === 'number' ? height : 34 }}
        >
          {chart}
        </ResponsiveContainer>
      )}
    </div>
  )
}
