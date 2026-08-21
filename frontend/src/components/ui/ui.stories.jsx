import React from 'react'
import Button from './Button'
import Card from './Card'
import StatusBadge from './StatusBadge'
import StatCell from './StatCell'
import ProgressBar from './ProgressBar'
import { SkeletonCard, SkeletonStats, SkeletonTable, SkeletonText } from './Skeleton'
import { ACCOUNT_STATUSES } from '../../utils/constants.js'

/**
 * The design system, every variant and state, in both themes.
 *
 * These stories exist to be LOOKED AT and to be SCREENSHOTTED. They are the
 * baseline the Playwright visual-regression project diffs against, which is why
 * each story renders the full set of a component's variants rather than one
 * example with knobs: a screenshot of a single configurable instance only ever
 * catches a regression in whichever configuration happened to be selected.
 *
 * Nothing here uses live data or a running backend. That is deliberate -- a
 * screenshot test whose content changes between runs reports a diff every time
 * and is muted within a week.
 */

export default {
  title: 'Design System/Primitives',
  parameters: {
    layout: 'padded'
  }
}

const Row = ({ children, label }) => (
  <div style={{ marginBottom: 'var(--space-6)' }}>
    <div style={{
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-2xs)',
      letterSpacing: '.14em',
      textTransform: 'uppercase',
      color: 'var(--muted)',
      marginBottom: 'var(--space-3)'
    }}>{label}</div>
    <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
      {children}
    </div>
  </div>
)

export const Buttons = () => (
  <div>
    <Row label="Variants">
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button>
    </Row>
    <Row label="Sizes">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
    </Row>
    <Row label="Disabled — must read as unavailable, and must not compress on press">
      <Button variant="primary" disabled>Primary</Button>
      <Button variant="secondary" disabled>Secondary</Button>
      <Button variant="danger" disabled>Danger</Button>
    </Row>
    <Row label="Full width">
      <div style={{ maxWidth: '320px' }}><Button full>Full width</Button></div>
    </Row>
  </div>
)

export const Cards = () => (
  <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: '640px' }}>
    <Card title="Plain card" eyebrow="Eyebrow">
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
        The default surface. Flat corners, hairline rule, no shadow.
      </p>
    </Card>
    <Card title="Ruled" ruled>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>A rule under the heading.</p>
    </Card>
    <Card title="Interactive" interactive>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
        Hover for the lift, press for the compression, tab to it for the ring.
      </p>
    </Card>
    <Card title="Actions" actions={<Button size="sm" variant="ghost">Action</Button>}>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>With a control in the header.</p>
    </Card>
  </div>
)

/**
 * Every status the platform can put on an account, not a representative few.
 * A badge whose colour is wrong for one status is invisible in a story that
 * renders three of twelve.
 */
export const Badges = () => (
  <Row label={`All ${Object.keys(ACCOUNT_STATUSES).length} account statuses`}>
    {Object.keys(ACCOUNT_STATUSES).map((status) => (
      <StatusBadge key={status} status={status} />
    ))}
  </Row>
)

export const Stats = () => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)' }}>
    <StatCell label="Balance" value="$104,238.50" />
    <StatCell label="Today" value="+$1,284.10" tone="gain" sub="+1.24%" />
    <StatCell label="Drawdown" value="-$612.40" tone="loss" sub="-0.59%" />
    <StatCell label="Open positions" value="7" sub="3 instruments" />
  </div>
)

export const Progress = () => (
  <div style={{ display: 'grid', gap: 'var(--space-5)', maxWidth: '420px' }}>
    <ProgressBar value={18} label="Profit target" />
    <ProgressBar value={64} label="Profit target" />
    <ProgressBar value={100} label="Profit target" />
  </div>
)

/**
 * The loading states, at the dimensions they actually hold.
 *
 * Worth a story of their own: a skeleton is the one component whose whole job is
 * to occupy the right amount of space, and that is a property you can only judge
 * by looking at it next to what it stands in for.
 */
export const Skeletons = () => (
  <div style={{ display: 'grid', gap: 'var(--space-6)', maxWidth: '720px' }}>
    <div>
      <Row label="Stats" />
      <SkeletonStats count={4} />
    </div>
    <div>
      <Row label="Card" />
      <SkeletonCard lines={3} />
    </div>
    <div>
      <Row label="Table" />
      <SkeletonTable rows={5} columns={5} />
    </div>
    <div>
      <Row label="Text" />
      <SkeletonText lines={4} />
    </div>
  </div>
)

/**
 * One page rendering every primitive together.
 *
 * The per-component stories catch a component regressing on its own; this
 * catches the ones that only show up in combination -- a card whose padding
 * fights the stat grid inside it, a badge that sits a pixel off the baseline of
 * the text beside it. It is also the single most useful screenshot to diff,
 * because a token change touches all of it at once.
 */
export const Everything = () => (
  <div style={{ display: 'grid', gap: 'var(--space-7)' }}>
    <Buttons />
    <Cards />
    <Badges />
    <Stats />
    <Progress />
    <Skeletons />
  </div>
)
