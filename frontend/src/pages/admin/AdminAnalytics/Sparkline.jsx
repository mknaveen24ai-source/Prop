import React from 'react';
import { LineChart, Line, YAxis, ResponsiveContainer } from 'recharts';

// Minimal inline trend line — no existing sparkline precedent in the app,
// built from the same recharts dependency already used by AdminChart.
export default function Sparkline({ data, dataKey = 'value', width = 90, height = 28, danger = false }) {
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <YAxis domain={['dataMin', 'dataMax']} hide />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={danger ? 'var(--admin-danger)' : 'var(--admin-text-muted)'}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
