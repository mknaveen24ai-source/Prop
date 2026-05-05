import React, { useState } from 'react';
import { TRADABLE_INSTRUMENTS_SUMMARY } from '../../utils/instruments';
import { useBranding } from '../../BrandingContext';
import { getTenantLandingCopy, isPaidTenant } from '../../utils/tenantMarketing';

export default function LandingFAQ() {
  const { tenant } = useBranding();
  const landingCopy = getTenantLandingCopy(tenant);
  const paidTenant = isPaidTenant(tenant);
  const [openIndex, setOpenIndex] = useState(null);

  const faqs = [
    {
      category: "General",
      q: paidTenant ? "How do I start a challenge?" : "Is this really 100% free?",
      a: landingCopy.faqItems[0]?.a || "Select an account size, start your challenge, and trade under the published rules."
    },
    {
      category: "General",
      q: "Why would you fund traders for free?",
      a: "We back traders with real capital and earn returns from successful trading. When you profit, it benefits both of us. We are selective about who we fund, which is why there is a 2-phase evaluation and limited spots each month."
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
      a: "Both Phase 1 and Phase 2 have identical core rules: hit the profit target within 30 calendar days without breaching the maximum drawdown limit. The rules are exactly the same across both phases — no surprises."
    },
    {
      category: "Rules",
      q: "What is the drawdown limit?",
      a: "The drawdown limits are set relative to your account size and are clearly displayed on your dashboard. They are the same for both Phase 1 and Phase 2."
    },
    {
      category: "Rules",
      q: "What is the time limit?",
      a: "Each phase has a 30 calendar day time limit. If you do not reach the profit target within 30 days, the evaluation is failed and you may claim a new account when spots are available."
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
      q: "What happens after I pass both phases?",
      a: "You receive a funded account . You can request payouts based on your trading profits."
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
    'General': '#2962ff',
    'Rules': '#7b61ff',
    'Funded': '#00c896',
  };

  return (
    <section className="mp-section" id="faq" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', bottom: '0', left: '50%', transform: 'translateX(-50%)', width: '600px', height: '400px', background: 'radial-gradient(circle, rgba(41, 98, 255, 0.03), transparent 70%)', pointerEvents: 'none' }} />

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
            const color = catColors[c] || '#2962ff';
            return (
              <button 
                key={c}
                onClick={() => { setActiveCat(c); setOpenIndex(null); }}
                style={{
                  padding: '10px 24px',
                  borderRadius: '100px',
                  background: isActive
                    ? `linear-gradient(135deg, ${color}22, ${color}11)`
                    : 'rgba(255,255,255,0.03)',
                  color: isActive ? color : 'rgba(255,255,255,0.45)',
                  border: isActive
                    ? `1px solid ${color}44`
                    : '1px solid rgba(255,255,255,0.06)',
                  cursor: 'pointer',
                  fontFamily: 'Sora, sans-serif', fontWeight: 600, fontSize: '14px',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  boxShadow: isActive ? `0 4px 16px ${color}15` : 'none',
                }}
              >
                {c}
              </button>
            );
          })}
        </div>

        {/* FAQ List */}
        <div className="mp-reveal mp-delay-400" style={{
          background: 'rgba(17, 24, 39, 0.4)',
          border: '1px solid rgba(255,255,255,0.04)',
          borderRadius: '24px',
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
                <p className="mp-p-body" style={{ color: 'rgba(255,255,255,0.45)', lineHeight: 1.8, fontSize: '15px' }}>{faq.a}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
