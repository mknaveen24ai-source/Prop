import React, { useState } from 'react';
import { TRADABLE_INSTRUMENTS_SUMMARY } from '../../utils/instruments';
import { getTenantLandingCopy } from '../../utils/tenantMarketing';

export default function LandingFAQ() {
  const landingCopy = getTenantLandingCopy();
  const [openIndex, setOpenIndex] = useState(null);

  const faqs = [
    {
      category: "General",
      q: "How do I start a challenge?",
      a: landingCopy.faqItems[0]?.a || "Choose a 1-step, 2-step, or 3-step model and account size, complete checkout, and trade under the published rules."
    },
    {
      category: "General",
      q: "Why is there a challenge fee?",
      a: "The fee covers the cost of backing your evaluation with real market data and, once you pass, real capital. We are selective about who we fund, which is why there is a multi-phase evaluation and limited spots each month."
    },
    {
      category: "General",
      q: "How many accounts are available?",
      a: "Most account sizes are open continuously. Where a size has a capacity limit, the counter on the pricing table is read live from the platform and shows exactly how many places remain — when it says a tier is open, it is open."
    },
    {
      category: "General",
      q: "Can I have more than one account?",
      a: "No — you can have one active evaluation and one funded account at a time. If your evaluation fails, you may claim a new one when spots are available."
    },
    {
      category: "General",
      q: "What account sizes are available?",
      a: "Seven sizes, from $5,000 to $400,000, across every model — 1-Step, 2-Step, and 3-Step. The same rules apply at every size; only the price and the dollar value of the targets change."
    },
    {
      category: "Rules",
      q: "What are the evaluation rules?",
      a: "Every phase of your chosen model has identical core rules: hit that phase's profit target within its time limit without breaching the maximum drawdown limit. Currently: 1-Step is a 16% target in 45 days; 2-Step is 10% then 8%, 45 days per phase; 3-Step is 8%, 6%, then 6%, 45 days per phase. The rules are exactly the same across every phase — no surprises."
    },
    {
      category: "Rules",
      q: "What is the drawdown limit?",
      a: "Currently 4% maximum trailing drawdown and 2% daily drawdown, on every model and every phase, evaluation and funded alike. The trailing floor only ever rises as you profit — it never resets against you. Exact dollar figures for your account are on your dashboard before you start."
    },
    {
      category: "Rules",
      q: "What is the time limit?",
      a: "Each phase has its own time limit, shown before you start — currently 45 days per phase on every model. If you do not reach the profit target in time, the evaluation is failed and you may start a new challenge when spots are available."
    },
    {
      category: "Rules",
      q: "Is there a minimum number of trading days?",
      a: "Yes — 5 qualifying trading days per evaluation phase, even if you hit the profit target sooner. A day only counts once you're up at least 0.75% of your starting balance on that day."
    },
    {
      category: "Rules",
      q: "What is the consistency rule?",
      a: "No single day's profit can make up more than 15% of your total profit when you hit the target. If it does, you're not failed — it's a soft hold. Keep trading to bring the ratio down and you'll pass automatically."
    },
    {
      category: "Rules",
      q: "What leverage do you offer?",
      a: "Leverage is unlimited and positions reserve no margin, so there is no cap on trade size relative to your account. The only structural limit is the number of positions you can hold at once. What actually governs your risk is the daily loss cap and the trailing drawdown floor \u2014 both published in full on the rules page, and both visible live on your dashboard."
    },
    {
      category: "Rules",
      q: "What instruments can I trade?",
      a: `You can trade ${TRADABLE_INSTRUMENTS_SUMMARY}.`
    },
    {
      category: "Rules",
      q: "Can I hold trades over the weekend?",
      a: "Weekend holding is currently enabled for every account, evaluation and funded alike — it's a single platform-wide setting, not something that changes when you get funded. If that setting is ever disabled, positions are flattened automatically before the weekend close."
    },
    {
      category: "Rules",
      q: "Do you allow automated trading bots?",
      a: "Manual trading is the primary method supported on our platform. Automated strategies executed through our platform's tools may be reviewed on a case-by-case basis. Generic publicly sold bots, Grid bots, Martingale systems, and copy-trade services are not permitted."
    },
    {
      category: "Rules",
      q: "Can I trade news events?",
      a: "Yes, news trading is allowed. Opening or closing a position within 2 minutes before or after a red-folder news release is restricted — no actions are permitted during that window."
    },
    {
      category: "Funded",
      q: "What happens after I pass every phase?",
      a: "You receive a funded account. You can request payouts based on your trading profits."
    },
    {
      category: "Funded",
      q: "How do payouts work?",
      a: "Payouts are available on a weekly basis. You keep 100% of your profits — we take no cut of what you earn, only the one-off entry fee. Minimum payout request is $50. Before your first payout, you need at least 10 qualifying trading days and 6% net profit on the account — after that, there's no further lock-up period."
    },
    {
      category: "Funded",
      q: "Does my drawdown protection improve as I profit?",
      a: "Yes. Once your funded account's equity reaches 2% above your starting balance, your drawdown floor locks in at that level for good — it won't drop back below it even if your equity pulls back later."
    },
    {
      category: "Funded",
      q: "Is there a scaling plan?",
      a: "Yes. Every time your funded account reaches a new 6% net-profit milestone, your risk-capacity multiplier doubles — compounding with every milestone you hit."
    },
    {
      category: "Funded",
      q: "What trading platform do you use?",
      a: "We use our own proprietary trading platform for all accounts — evaluation and funded. You trade directly in our platform from your browser. No downloads required. You will receive your login credentials after claiming your account."
    },
    {
      category: "Funded",
      q: "What happens if I breach a rule on my funded account?",
      a: "If you breach the drawdown limits on your funded account, the account will be closed. You may claim a new evaluation account when spots are available next month."
    },
  ];

  const categories = [...new Set(faqs.map(f => f.category))];
  const [activeCat, setActiveCat] = useState(categories[0]);

  const catColors = {
    'General': 'var(--muted)',
    'Rules': 'var(--muted)',
    'Funded': 'var(--gain)',
  };

  return (
    <section className="mp-section" id="faq" style={{ position: 'relative' }}>
      <div className="mp-container" style={{ maxWidth: '800px' }}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-10)' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: 'var(--space-5)' }}>
            <span className="mp-badge-dot"></span>
            FAQ
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">Still On The Fence? Here's Every Answer.</h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            {landingCopy.faqLead}
          </p>
        </div>

        {/* Category Pills */}
        <div className="mp-reveal mp-delay-300" style={{ display: 'flex', gap: 'var(--space-2-5)', flexWrap: 'wrap', justifyContent: 'center', marginBottom: 'var(--space-9)' }}>
          {categories.map(c => {
            const isActive = activeCat === c;
            const color = catColors[c] || 'var(--muted)';
            return (
              <button 
                key={c}
                onClick={() => { setActiveCat(c); setOpenIndex(null); }}
                style={{
                  padding: 'var(--space-2-5) var(--space-6)',
                  background: 'transparent',
                  color: isActive ? color : 'var(--muted)',
                  border: isActive
                    ? `1px solid ${color}`
                    : '1px solid var(--rule)',
                  cursor: 'pointer',
              fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--fs-md)',
                  transition: 'border-color 0.2s ease, color 0.2s ease',
                }}
              >
                {c}
              </button>
            );
          })}
        </div>

        {/* FAQ List */}
        <div className="mp-reveal mp-delay-400" style={{
          background: 'var(--paper-2)',
          border: '1px solid var(--rule)',
          padding: 'var(--space-2) var(--space-7)',
        }}>
          {faqs.filter(f => f.category === activeCat).map((faq, i) => (
            <div key={i} className={'mp-faq-item ' + (openIndex === i ? 'active' : '')}>
              <button className="mp-faq-btn" onClick={() => setOpenIndex(openIndex === i ? null : i)}>
                <span style={{ paddingRight: 'var(--space-5)' }}>{faq.q}</span>
                <div className="mp-faq-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </div>
              </button>
              <div className="mp-faq-content">
                <p className="mp-p-body" style={{ color: 'var(--muted)', lineHeight: 1.8, fontSize: 'var(--fs-lg)' }}>{faq.a}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
