import React from 'react';
import { Link } from 'react-router-dom';
import { useBranding } from '../../BrandingContext';

const ROWS = [
  {
    label: 'Account access',
    us: 'Monthly batch releases with transparent availability',
    others: 'Always-open sales funnels with vague capacity'
  },
  {
    label: 'Payout proof',
    us: 'Backend-synced paid-out tracker',
    others: 'Static screenshots or unverifiable claims'
  },
  {
    label: 'Evaluation model',
    us: 'Same disclosed rules at every phase, whichever model you pick',
    others: 'Hidden review rules revealed after traders pass'
  },
  {
    label: 'Risk controls',
    us: 'News, rollover, drawdown, and max-trade controls',
    others: 'Rule enforcement only after a dispute'
  },
  {
    label: 'Support workflow',
    us: 'KYC, disputes, tickets, and admin queues in one system',
    others: 'Manual inboxes and scattered evidence'
  }
];

export default function LandingComparison() {
  const { tenant } = useBranding();
  const brandName = tenant?.name || 'PropFirm';

  return (
    <section className="mp-section mp-comparison-section" aria-labelledby="mp-comparison-title">
      <div className="mp-container">
        <div className="mp-comparison-shell mp-reveal">
          <div className="mp-comparison-heading">
            <div>
              <div className="mp-badge" style={{ marginBottom: 18 }}>
                <span className="mp-badge-dot"></span>
                Why us vs others
              </div>
              <h2 id="mp-comparison-title" className="mp-h2">Why Traders Leave Other Firms For Us</h2>
              <p className="mp-p-lead">
                You'll compare firms before you register — good. Here's the side-by-side, no marketing spin required.
              </p>
            </div>
            <Link to="/register" className="mp-btn-secondary mp-comparison-cta">
              Start with {brandName}
            </Link>
          </div>

          <div className="mp-comparison-table" role="table" aria-label={`${brandName} comparison`}>
            <div className="mp-comparison-row header" role="row">
              <div role="columnheader">Decision point</div>
              <div role="columnheader">{brandName}</div>
              <div role="columnheader">Other firms</div>
            </div>
            {ROWS.map((row) => (
              <div className="mp-comparison-row" role="row" key={row.label}>
                <div role="cell">
                  <strong>{row.label}</strong>
                </div>
                <div role="cell" className="positive">
                  <span>✓</span>
                  {row.us}
                </div>
                <div role="cell" className="muted">
                  <span>×</span>
                  {row.others}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
