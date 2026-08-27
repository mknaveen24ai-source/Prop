import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api';

// ─────────────────────────────────────────────────────────────────────────────
// PROOF — replaces the former "Wall of Love".
//
// That section carried eight invented testimonials attributed to "Funded
// Trader · 2-Step Program". They were labelled illustrative, but a trader who
// has been burned by a prop firm before discounts invented quotes instantly —
// and one of them made a factual claim about the business model ("real
// liquidity, not a simulated bucket shop") that the platform's own code
// contradicts.
//
// The slot now holds the things that can actually be checked: the live pass
// rate per model, the published payout ledger, verifiable certificates, and the
// full rulebook. Every figure here is read from the platform, and every claim
// links to somewhere the reader can verify it themselves.
//
// When there are real, attributed trader testimonials to publish, they belong
// BESIDE this — not instead of it.
// ─────────────────────────────────────────────────────────────────────────────

function ProofCard({ eyebrow, headline, body, to, cta, figure, figureNote }) {
  return (
    <div className="mp-glass-card" style={{ padding: 'var(--space-7)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', height: '100%' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--warn)' }}>
        {eyebrow}
      </div>

      {figure !== undefined && (
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-6xl)', fontWeight: 700, lineHeight: 1, color: 'var(--ink)' }}>
            {figure}
          </div>
          {figureNote && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', marginTop: 'var(--space-1-5)' }}>{figureNote}</div>
          )}
        </div>
      )}

      <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 600, color: 'var(--ink)', textWrap: 'balance' }}>
        {headline}
      </div>

      <p className="mp-p-body" style={{ fontSize: 'var(--fs-md)', lineHeight: 1.7, color: 'var(--muted)', margin: 0, flex: 1 }}>
        {body}
      </p>

      <Link to={to} style={{ color: 'var(--warn)', fontSize: 'var(--fs-base)', fontFamily: 'var(--font-mono)', textDecoration: 'none' }}>
        {cta} →
      </Link>
    </div>
  );
}

export default function LandingWallOfLove() {
  const [passRates, setPassRates] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/api/transparency/pass-rates', { skipAuthRedirect: true })
      .then((res) => { if (!cancelled) setPassRates(res.data); })
      .catch(() => { /* the other three cards stand on their own */ });
    return () => { cancelled = true; };
  }, []);

  const overall = passRates?.overall;
  const hasPassData = overall?.pass_rate != null && overall.finished > 0;

  return (
    <section className="mp-section" style={{ background: 'var(--paper-2)', position: 'relative' }}>
      <div className="mp-container">
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-11)' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: 'var(--space-5)' }}>
            <span className="mp-badge-dot"></span>
            Proof
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">Don&apos;t Take Our Word For It. Check.</h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            We have no trader testimonials to show you yet, so here is something better: four things
            you can verify yourself, without an account.
          </p>
        </div>

        <div
          className="mp-reveal mp-delay-300"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--space-5)' }}
        >
          <ProofCard
            eyebrow="Published pass rate"
            figure={hasPassData ? `${overall.pass_rate}%` : '—'}
            figureNote={hasPassData
              ? `${overall.funded.toLocaleString()} of ${overall.finished.toLocaleString()} finished evaluations`
              : 'Published from the first finished evaluation'}
            headline="The number nobody else publishes"
            body="Evaluations that reached a funded account, divided by evaluations that have finished. In-progress challenges are excluded from both sides. It updates nightly, and it goes up whether it flatters us or not."
            to="/transparency"
            cta="See the full breakdown"
          />

          <ProofCard
            eyebrow="Payout ledger"
            headline="Every payout we've made, in public"
            body="Total paid, number of payouts, countries, and how fast we settle — read live from the same ledger our finance team approves against. Not a marketing estimate, and not a number we can quietly edit."
            to="/transparency"
            cta="Open the ledger"
          />

          <ProofCard
            eyebrow="The rulebook"
            headline="Every rule, before you pay"
            body="The full rule set — drawdown, consistency, qualifying days, execution behaviour — rendered live from the platform's own settings. Read it before you spend anything. Nothing is held in a separate schedule."
            to="/rules"
            cta="Read the rules"
          />

          <ProofCard
            eyebrow="Verifiable certificates"
            headline="Achievements you can check"
            body="Every payout and phase pass mints a signed certificate with a public verification URL. Anyone can confirm it is genuine without logging in — including a trader deciding whether to trust us."
            to="/transparency"
            cta="How verification works"
          />
        </div>
      </div>
    </section>
  );
}
