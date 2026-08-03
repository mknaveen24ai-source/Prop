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

  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
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
      </ResponsiveContainer>
    </div>
  )
}
