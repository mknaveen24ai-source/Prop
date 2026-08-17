import React from 'react';
import { AreaChart, Area, YAxis } from 'recharts';

// Sparkline chart contract (v2 "Modern Gazette" handoff spec): ~100x34,
// 1.6px stroke, 12% fill, an end dot marking the last value, no axes, no
// labels, no interaction.
export default function Sparkline({ data, dataKey = 'value', width = 100, height = 34, danger = false }) {
  const tone = danger ? 'var(--admin-danger)' : 'var(--admin-text-muted)';
  const lastIndex = Array.isArray(data) ? data.length - 1 : -1;

  // Fixed pixel size, so no ResizeObserver: ResponsiveContainer would render a
  // -1x-1 first frame and log "The width(-1) and height(-1) of chart should be
  // greater than 0" once per row. Same reasoning as components/ui/Sparkline.
  return (
    <div style={{ width, height }}>
      <AreaChart width={width} height={height} data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
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
            if (props.index !== lastIndex) return null;
            return <circle key={`sp-dot-${props.index}`} cx={props.cx} cy={props.cy} r={2} fill={tone} stroke="none" />;
          }}
        />
      </AreaChart>
    </div>
  );
}
