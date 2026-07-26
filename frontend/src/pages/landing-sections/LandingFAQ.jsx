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
      a: "Accounts are released in limited monthly batches based on our available liquidity. The exact number varies by account size. Once all spots for a given tier are claimed, you need to wait for the next monthly release."
    },
    {
      category: "General",
      q: "Can I have more than one account?",
      a: "NO You cant have more than one active evaluation and one funded account at a time. If your evaluation fails, you may claim a new one when spots are available."
    },
    {
      category: "Rules",
      q: "What are the evaluation rules?",
      a: "Every phase of your chosen model has identical core rules: hit that phase's profit target within its time limit without breaching the maximum drawdown limit. The rules are exactly the same across every phase — no surprises."
    },
    {
      category: "Rules",
      q: "What is the drawdown limit?",
      a: "The drawdown limits are set relative to your account size and model, and are clearly displayed on your dashboard before you start. They stay the same across every phase of your challenge."
    },
    {
      category: "Rules",
      q: "What is the time limit?",
      a: "Each phase has its own time limit, shown before you start. If you do not reach the profit target in time, the evaluation is failed and you may start a new challenge when spots are available."
    },
    {
      category: "Rules",
      q: "What leverage do you offer?",
      a: "Forex pairs have 1:30 leverage. Commodities (Gold and Silver) have 1:10 leverage. These are conservative levels designed to encourage proper risk management."
    },
    {
      category: "Rules",
      q: "What instruments can I trade?",
      a: `You can trade ${TRADABLE_INSTRUMENTS_SUMMARY}.`
    },
    {
      category: "Rules",
      q: "Can I hold trades over the weekend?",
      a: "During the evaluation phases, weekend holding is allowed. On funded accounts, all positions must be closed before the market closes on Friday to avoid weekend gap risk."
    },
    {
      category: "Rules",
      q: "Do you allow automated trading bots?",
      a: "Manual trading is the primary method supported on our platform. Automated strategies executed through our platform's tools may be reviewed on a case-by-case basis. Generic publicly sold bots, Grid bots, Martingale systems, and copy-trade services are not permitted."
    },
    {
      category: "Rules",
      q: "Can I trade news events?",
      a: "Yes, news trading is allowed. However, Opening position and Closing positions before 3 min and after 3 min of a red folder news is restricted.Traders cant peform any actions during that time. "
    },
    {
      category: "Funded",
      q: "What happens after I pass every phase?",
      a: "You receive a funded account. You can request payouts based on your trading profits."
    },
    {
      category: "Funded",
      q: "How do payouts work?",
      a: "Payouts are available on a Weekly basis. The minimum payout threshold and profit split details are displayed on your funded account dashboard."
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
        <div style={{ textAlign: 'center', marginBottom: '60px' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: '20px' }}>
            <span className="mp-badge-dot"></span>
            FAQ
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">Frequently Asked Questions</h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            {landingCopy.faqLead}
          </p>
        </div>

        {/* Category Pills */}
        <div className="mp-reveal mp-delay-300" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '48px' }}>
          {categories.map(c => {
            const isActive = activeCat === c;
            const color = catColors[c] || 'var(--muted)';
            return (
              <button 
                key={c}
                onClick={() => { setActiveCat(c); setOpenIndex(null); }}
                style={{
                  padding: '10px 24px',
                  background: 'transparent',
                  color: isActive ? color : 'var(--muted)',
                  border: isActive
                    ? `1px solid ${color}`
                    : '1px solid var(--rule)',
                  cursor: 'pointer',
              fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '14px',
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
          padding: '8px 32px',
        }}>
          {faqs.filter(f => f.category === activeCat).map((faq, i) => (
            <div key={i} className={'mp-faq-item ' + (openIndex === i ? 'active' : '')}>
              <button className="mp-faq-btn" onClick={() => setOpenIndex(openIndex === i ? null : i)}>
                <span style={{ paddingRight: '20px' }}>{faq.q}</span>
                <div className="mp-faq-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </div>
              </button>
              <div className="mp-faq-content">
                <p className="mp-p-body" style={{ color: 'var(--muted)', lineHeight: 1.8, fontSize: '15px' }}>{faq.a}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
