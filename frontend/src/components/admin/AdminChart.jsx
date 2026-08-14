import React from 'react';
import { ResponsiveContainer, Sector } from 'recharts';
import Card from '../ui/Card';

export default function AdminChart({
  children,
  height = 300,
  title,
  eyebrow,
  empty
}) {
  return (
    <Card title={title} eyebrow={eyebrow}>
      {empty ? (
        // Rendered outside ResponsiveContainer on purpose: its inner wrapper
        // collapses to a 0×0 box (relying on `overflow: visible` for SVG
        // charts to paint past it), which makes ordinary text wrap to one
        // word per line instead of centering.
        <div style={{ width: '100%', height, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          {empty}
        </div>
      ) : (
        <div style={{ width: '100%', height }}>
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

// Helper props to inject into standard Recharts components
export const chartThemeProps = {
  grid: { stroke: 'var(--rule)', strokeDasharray: '3 3', vertical: false },
  xAxis: { stroke: 'var(--admin-text-faint)', tick: { fill: 'var(--admin-text-muted)', fontSize: 11 }, tickLine: false, axisLine: false },
  yAxis: { stroke: 'var(--admin-text-faint)', tick: { fill: 'var(--admin-text-muted)', fontSize: 11 }, tickLine: false, axisLine: false },
  tooltip: {
    contentStyle: {
      backgroundColor: 'var(--admin-elevated)',
      backdropFilter: 'blur(16px) saturate(140%)',
      WebkitBackdropFilter: 'blur(16px) saturate(140%)',
      borderColor: 'var(--admin-border-strong)',
      borderRadius: 'var(--radius-sm)',
      color: 'var(--admin-text)',
      boxShadow: 'var(--elev)'
    },
    itemStyle: { color: 'var(--admin-text)', fontSize: '13px' },
    labelStyle: { color: 'var(--admin-text-muted)', marginBottom: '8px', fontSize: '12px', fontWeight: 600 }
  }
};

// Donut hover contract (v2 "Modern Gazette" handoff spec): the hovered arc
// grows 5px past its base radius. Pass as <Pie activeShape={renderActiveDonutArc} />.
export function renderActiveDonutArc(props) {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props;
  return (
    <Sector
      cx={cx} cy={cy}
      innerRadius={innerRadius}
      outerRadius={outerRadius + 5}
      startAngle={startAngle}
      endAngle={endAngle}
      fill={fill}
    />
  );
}

// Dims every slice/bar except the hovered one to 32% — spread as
// `fillOpacity` on a <Cell>, keyed by the hovered index (component state,
// null when nothing is hovered) vs. this element's own index.
export function dimUnlessActive(activeIndex, index) {
  return activeIndex == null || activeIndex === index ? 1 : 0.32;
}

// Stacked-bar hover contract (v2 "Modern Gazette" handoff spec): hovering a
// column dims every other column to 32% and prints the column's total above
// the stack. Spread onto <BarChart>; pairs with `dimUnlessActive` (per <Cell>
// fillOpacity) and `renderStackedTotalLabel` (as one series's `label` prop) —
// both keyed off the same activeIndex state the caller owns.
export function barHoverHandlers(setActiveIndex) {
  return {
    onMouseMove: (state) => {
      if (state?.isTooltipActive) setActiveIndex(state.activeTooltipIndex);
    },
    onMouseLeave: () => setActiveIndex(null),
  };
}

export function renderStackedTotalLabel(activeIndex, getTotal) {
  return function StackedTotalLabel(props) {
    const { x, y, width, index } = props;
    if (index !== activeIndex) return null;
    const total = getTotal(index);
    if (total == null) return null;
    return (
      <text
        x={x + width / 2}
        y={y - 8}
        textAnchor="middle"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, fill: 'var(--admin-text)' }}
      >
        {total}
      </text>
    );
  };
}
