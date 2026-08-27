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

// Below this many completed payouts the ledger has nothing meaningful to show,
// and a section headlined "We publish them" over four zeros is worse than no
// section at all. Under the threshold we lead with the pass rate instead —
// which is real from the first finished evaluation.
const MIN_PAYOUTS_TO_SHOW_LEDGER = 10;

export default function LandingLiveStats() {
  const [stats, setStats] = useState(EMPTY_STATS);
  const [passRates, setPassRates] = useState(null);
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

    async function loadPassRates() {
      try {
        const response = await api.get('/api/transparency/pass-rates', { skipAuthRedirect: true });
        if (!cancelled) setPassRates(response.data || null);
      } catch {
        // Additive — the ledger block still renders without it.
      }
    }

    loadStats();
    loadPassRates();
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
  const ledgerReady = Number(stats.paid_payout_count || 0) >= MIN_PAYOUTS_TO_SHOW_LEDGER;
  const passModels = (passRates?.models || []).filter((m) => m.pass_rate != null);
  const overallPass = passRates?.overall?.pass_rate;

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
              <h2 id="mp-live-stats-title" className="mp-h2">
                {ledgerReady
                  ? "We Don't Just Promise Payouts. We Publish Them."
                  : 'We Publish Our Pass Rate. Nobody Else Does.'}
              </h2>
              <p className="mp-p-lead">
                {ledgerReady
                  ? "Every number below is read live from the platform's approved payout ledger — not a marketing estimate. It updates the moment our team marks a trader paid."
                  : 'Read live from the platform, including the numbers most firms hide. The payout ledger publishes here too, the moment there is something in it to publish.'}
              </p>
            </div>
            <div className={`mp-live-status ${status === 'loading' ? 'loading' : ''}`}>
              <span></span>
              {status === 'loading' ? 'Syncing' : 'Backend synced'}
            </div>
          </div>

          {/* Pass rates — real from the first finished evaluation, so this leads
              before the payout ledger has anything in it. */}
          <div className="mp-live-stats-grid">
            {passModels.length > 0 ? (
              <>
                {overallPass != null && (
                  <div className="mp-live-stat-card">
                    <span>Pass rate · all models</span>
                    <strong>{overallPass}%</strong>
                    <small>{passRates.overall.funded.toLocaleString()} of {passRates.overall.finished.toLocaleString()} finished</small>
                  </div>
                )}
                {passModels.map((m) => (
                  <div className="mp-live-stat-card" key={m.slug}>
                    <span>Pass rate · {m.slug}</span>
                    <strong>{m.pass_rate}%</strong>
                    <small>{m.funded.toLocaleString()} of {m.finished.toLocaleString()} finished</small>
                  </div>
                ))}
              </>
            ) : (
              <div className="mp-live-stat-card">
                <span>Pass rate</span>
                <strong>—</strong>
                <small>Published as soon as an evaluation finishes</small>
              </div>
            )}
          </div>

          {ledgerReady && (
            <>
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
                {recent.map((payout) => (
                  <div className="mp-payout-chip" key={payout.id}>
                    <strong>{formatMoney(payout.amount)}</strong>
                    <span>{payout.trader_name || 'Trader'}{payout.country ? ` · ${payout.country}` : ''}</span>
                    <small>{formatDate(payout.paid_at)}</small>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
