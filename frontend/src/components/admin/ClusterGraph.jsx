import React, { useMemo } from 'react';

/**
 * Bipartite link graph for an account-sharing cluster.
 *
 * Traders sit on the left, the shared values that tie them together on the
 * right, with an edge for each user that presented a value. Drawing it this way
 * rather than user-to-user makes the reason for the link readable: an admin can
 * see at a glance that three accounts connect through one payout wallet, not
 * merely that "these are related".
 *
 * Deliberately plain SVG with a deterministic layout — no force simulation and
 * no charting dependency. Clusters are small (a handful of nodes) and a layout
 * that jumps around between renders is harder to reason about, not easier.
 */

const ROW_HEIGHT = 46;
const PADDING_Y = 24;
const USER_X = 150;
const SIGNAL_X = 470;
const WIDTH = 620;

// Signals that are close to proof on their own get the danger colour.
const STRONG_SIGNALS = new Set(['payout_dest', 'kyc_doc', 'simultaneous_execution', 'device_fp']);

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export default function ClusterGraph({ nodes = [], edges = [] }) {
  const layout = useMemo(() => {
    const users = nodes.filter((node) => node.type === 'user');
    const signals = nodes.filter((node) => node.type !== 'user');

    const positions = new Map();
    users.forEach((node, index) => {
      positions.set(node.id, { x: USER_X, y: PADDING_Y + index * ROW_HEIGHT, node, side: 'user' });
    });
    signals.forEach((node, index) => {
      positions.set(node.id, { x: SIGNAL_X, y: PADDING_Y + index * ROW_HEIGHT, node, side: 'signal' });
    });

    const height = PADDING_Y * 2 + Math.max(users.length, signals.length, 1) * ROW_HEIGHT;
    return { positions, users, signals, height };
  }, [nodes]);

  if (nodes.length === 0) {
    return <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)' }}>No graph data.</p>;
  }

  return (
    // Wide graphs scroll inside their own container rather than pushing the
    // modal body sideways.
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <svg
        width={WIDTH}
        height={layout.height}
        viewBox={`0 0 ${WIDTH} ${layout.height}`}
        role="img"
        aria-label="Account link graph"
        style={{ display: 'block' }}
      >
        {edges.map((edge, index) => {
          const source = layout.positions.get(edge.source);
          const target = layout.positions.get(edge.target);
          if (!source || !target) return null;
          const strong = STRONG_SIGNALS.has(edge.type);
          return (
            <line
              key={`${edge.source}-${edge.target}-${index}`}
              x1={source.x + 4}
              y1={source.y}
              x2={target.x - 4}
              y2={target.y}
              stroke={strong ? 'var(--admin-danger, #e5484d)' : 'var(--admin-border, #3a3a3a)'}
              strokeWidth={strong ? 1.8 : 1}
              opacity={strong ? 0.75 : 0.45}
            />
          );
        })}

        {layout.users.map((node) => {
          const position = layout.positions.get(node.id);
          return (
            <g key={node.id}>
              <circle cx={position.x} cy={position.y} r={5} fill="var(--admin-accent, #5b8def)" />
              <text
                x={position.x - 12}
                y={position.y + 4}
                textAnchor="end"
                fontSize="11"
                fill="var(--admin-text, #e6e6e6)"
              >
                {truncate(node.label, 22)}
              </text>
            </g>
          );
        })}

        {layout.signals.map((node) => {
          const position = layout.positions.get(node.id);
          const strong = STRONG_SIGNALS.has(node.type);
          return (
            <g key={node.id}>
              <rect
                x={position.x - 5}
                y={position.y - 5}
                width={10}
                height={10}
                rx={2}
                fill={strong ? 'var(--admin-danger, #e5484d)' : 'var(--admin-text-muted, #8a8a8a)'}
              />
              <text
                x={position.x + 14}
                y={position.y + 4}
                fontSize="11"
                fill={strong ? 'var(--admin-danger, #e5484d)' : 'var(--admin-text-muted, #8a8a8a)'}
              >
                {truncate(node.label, 30)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
