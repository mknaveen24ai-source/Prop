import React, { useEffect, useMemo, useState } from 'react';
import api from '../../services/api';

const EMPTY_STATS = {
  total_paid_out: 0,
  paid_payout_count: 0,
  funded_trader_count: 0,
  country_count: 0,
  same_day_payout_rate: 0,
  recent_payouts: []
};

function formatMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(amount >= 10000000 ? 0 : 1)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(amount >= 10000 ? 0 : 1)}K`;
  return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatDate(value) {
  if (!value) return 'Recently paid';
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
  } catch {
    return 'Recently paid';
  }
}

export default function LandingLiveStats() {
  const [stats, setStats] = useState(EMPTY_STATS);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      try {
        const response = await api.get('/api/public/landing-stats', {
          skipAuthRedirect: true
        });
        if (cancelled) return;
        setStats({ ...EMPTY_STATS, ...(response.data || {}) });
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('fallback');
      }
    }

    loadStats();
    const interval = window.setInterval(loadStats, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const statItems = useMemo(() => ([
    {
      label: 'Total paid out',
      value: formatMoney(stats.total_paid_out),
      detail: `${formatNumber(stats.paid_payout_count)} completed payouts`
    },
    {
      label: 'Funded traders',
      value: formatNumber(stats.funded_trader_count),
      detail: 'Across active funded accounts'
    },
    {
      label: 'Countries',
      value: formatNumber(stats.country_count),
      detail: 'Trader footprint'
    },
    {
      label: 'Same-day payouts',
      value: `${Number(stats.same_day_payout_rate || 0)}%`,
      detail: 'Paid within 24 hours'
    }
  ]), [stats]);

  const recent = Array.isArray(stats.recent_payouts) ? stats.recent_payouts : [];

  return (
    <section className="mp-section mp-live-stats-section" aria-labelledby="mp-live-stats-title">
      <div className="mp-container">
        <div className="mp-live-stats-shell mp-reveal">
          <div className="mp-live-stats-header">
            <div>
              <div className="mp-badge" style={{ marginBottom: 18 }}>
                <span className="mp-badge-dot"></span>
                Live Payout Tracker
              </div>
              <h2 id="mp-live-stats-title" className="mp-h2">We Don't Just Promise Payouts. We Publish Them.</h2>
              <p className="mp-p-lead">
                Every number below is read live from the platform's approved payout ledger — not a marketing estimate. It updates the moment our team marks a trader paid.
              </p>
            </div>
            <div className={`mp-live-status ${status === 'loading' ? 'loading' : ''}`}>
              <span></span>
              {status === 'loading' ? 'Syncing' : 'Backend synced'}
            </div>
          </div>

          <div className="mp-live-stats-grid">
            {statItems.map((item) => (
              <div className="mp-live-stat-card" key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.detail}</small>
              </div>
            ))}
          </div>

          <div className="mp-payout-tape" aria-label="Recent payout feed">
            {recent.length > 0 ? recent.map((payout) => (
              <div className="mp-payout-chip" key={payout.id}>
                <strong>{formatMoney(payout.amount)}</strong>
                <span>{payout.trader_name || 'Trader'}{payout.country ? ` · ${payout.country}` : ''}</span>
                <small>{formatDate(payout.paid_at)}</small>
              </div>
            )) : (
              <div className="mp-payout-chip empty">
                <strong>{formatMoney(0)}</strong>
                <span>First public payout will appear here</span>
                <small>Live from admin approvals</small>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
