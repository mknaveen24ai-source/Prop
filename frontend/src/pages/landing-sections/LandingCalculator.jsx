import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { accountsAPI } from '../../services/api';
import { setMemoryItem } from '../../utils/memoryStore';
import { renderIcon } from '../../utils/iconMap';

const RECOMMENDED_SIZE = 25000;
const FALLBACK_ACCOUNT_SIZES = [5000, 10000, 25000, 50000, 100000, 200000, 400000];

function sizeLabel(size) {
  if (size >= 200000) return 'Institutional';
  if (size >= 100000) return 'Enterprise';
  if (size >= 50000)  return 'Elite';
  if (size >= 25000)  return 'Pro';
  if (size >= 10000)  return 'Standard';
  if (size >= 5000)   return 'Advanced';
  if (size >= 1000)   return 'Starter';
  return 'Micro';
}

// Good/better/best framing — ordered fastest-and-priciest to slowest-and-cheapest
// so the price spread does the anchoring work on its own (real prices, no invented claims).
const MODEL_HOOKS = {
  1: { badge: 'FASTEST TO FUNDED', color: 'var(--warn)' },
  2: { badge: 'MOST BALANCED', color: 'var(--ink)' },
  3: { badge: 'LOWEST COST TO START', color: 'var(--gain)' },
};

function InfoDot({ title }) {
  return (
    <span title={title} style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: 'var(--space-1)', cursor: 'help', opacity: 0.6 }}>
      {renderIcon('info', { size: 11, color: 'currentColor' })}
    </span>
  );
}

export default function LandingCalculator({ onStartAssessment }) {
  const navigate = useNavigate();
  const [models, setModels] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [accountSizes, setAccountSizes] = useState(FALLBACK_ACCOUNT_SIZES);
  const [availabilitySource, setAvailabilitySource] = useState('config');
  const [selectedModelSlug, setSelectedModelSlug] = useState(null);

  // Models + pricing + per-size slot availability, in one response — polled so
  // "sold out" state stays fresh without a second, separately-scoped fetch.
  useEffect(() => {
    async function fetchModels() {
      try {
        const res = await accountsAPI.getPublicStepModels();
        const list = Array.isArray(res.data?.models) ? res.data.models : [];
        list.sort((a, b) => (a.steps || 0) - (b.steps || 0));
        setModels(list);
        if (Array.isArray(res.data?.account_sizes) && res.data.account_sizes.length > 0) {
          setAccountSizes(res.data.account_sizes);
        }
        setAvailabilitySource('live');
      } catch (_err) {
        setModels([]);
        setAvailabilitySource('offline');
      } finally {
        setModelsLoaded(true);
      }
    }
    fetchModels();
    const iv = setInterval(fetchModels, 30000);
    return () => clearInterval(iv);
  }, []);

  // A fetched first model is the visual default without a state-sync render.
  // User selection still wins as soon as a tab is chosen.
  const effectiveModelSlug = selectedModelSlug || models[0]?.slug || null;
  const selectedModel = models.find(m => m.slug === effectiveModelSlug) || null;
  const activePricing = (selectedModel?.pricing || []).filter(p => p.is_active);
  const totalEnabled = activePricing.filter(p => !p.locked).length;
  const hasUnlimitedAvailability = activePricing.some(p => !p.locked && p.is_unlimited);
  const totalRemaining = hasUnlimitedAvailability
    ? null
    : activePricing.filter(p => !p.locked).reduce((sum, p) => sum + (p.remaining || 0), 0);

  function startChallenge(size) {
    setMemoryItem('pendingChallenge', JSON.stringify({
      accountSize: size,
      stepModel: selectedModel?.slug || null,
      accountType: 'phase1'
    }));
    if (onStartAssessment) onStartAssessment(size, selectedModel?.slug);
    navigate('/checkout');
  }

  return (
    <section id="mp-accounts" className="mp-section" style={{
      background: 'var(--paper-2)',
      borderTop: '1px solid var(--rule)',
      borderBottom: '1px solid var(--rule)',
      position: 'relative',
    }}>
      <div className="mp-container">
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-9)' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: 'var(--space-5)' }}>
            Choose Your Challenge
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">Pick Your Path to Funded</h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            1 Step, 2 Step, or 3 Step. Every model trades under the exact same rules — no hidden catches either way.
          </p>

          {availabilitySource !== 'live' && (
            <p className="mp-reveal mp-delay-250" style={{ margin: 'var(--space-3-5) auto 0', color: 'var(--muted)', maxWidth: '740px', fontSize: 'var(--fs-base)' }}>
              {availabilitySource === 'config'
                ? 'Tier availability on this page follows admin-configured quotas and refreshes automatically.'
                : 'Live availability is temporarily unavailable. You can still register and claim the next open tier.'}
            </p>
          )}
        </div>

        {/* ── Model tab bar ── */}
        {modelsLoaded && models.length > 0 && (
          <div className="mp-reveal mp-delay-300" style={{
            display: 'flex',
            justifyContent: 'center',
            flexWrap: 'wrap',
            gap: 'var(--space-2-5)',
            marginBottom: 'var(--space-5)',
          }}>
            {models.map((m) => {
              const hook = MODEL_HOOKS[m.steps] || { badge: `${m.steps} PHASES`, color: 'var(--muted)' };
              const active = m.slug === selectedModelSlug;
              return (
                <button
                  key={m.slug}
                  type="button"
                  onClick={() => setSelectedModelSlug(m.slug)}
                  style={{
                    cursor: 'pointer',
                    textAlign: 'center',
                    background: active ? 'var(--ink)' : 'var(--paper)',
                    border: `1px solid ${active ? 'var(--ink)' : 'var(--rule)'}`,
                    padding: 'var(--space-2-5) var(--space-6)',
                    minWidth: '160px',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{
                    fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800,
                    color: active ? 'var(--paper)' : 'var(--ink)',
                  }}>
                    {m.name}
                  </div>
                  <div style={{
                    marginTop: 'var(--space-1)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: '0.08em',
                    color: active ? hook.color : 'var(--muted)',
                  }}>
                    {hook.badge}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {modelsLoaded && models.length === 0 && (
          <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--muted)' }}>
            Challenge models are temporarily unavailable. Please check back shortly.
          </div>
        )}

        {selectedModel && (
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-7)' }}>
            <div className="mp-availability-pill mp-reveal mp-delay-300" style={{ display: 'inline-flex', gap: 'var(--space-6)', padding: 'var(--space-3) var(--space-7)', background: 'transparent', border: '1px solid var(--rule)' }}>
              <span style={{ fontSize: 'var(--fs-base)', color: 'var(--muted)' }}>
                Sizes Available: <span style={{ color: 'var(--ink)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{totalEnabled}</span>
              </span>
              <span style={{ width: '1px', background: 'var(--rule)' }} />
              <span style={{ fontSize: 'var(--fs-base)', color: 'var(--muted)' }}>
                Remaining Slots: <span style={{ color: hasUnlimitedAvailability || totalRemaining > 0 ? 'var(--gain)' : 'var(--warn)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{hasUnlimitedAvailability ? 'Unlimited' : totalRemaining}</span>
              </span>
            </div>
          </div>
        )}

        {/* ── Size + rules + price cards for the chosen model ── */}
        {selectedModel && (
          <div className="mp-account-size-grid mp-reveal mp-delay-300" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 'var(--space-4)',
            maxWidth: '1300px',
            margin: '0 auto var(--space-10)',
            alignItems: 'stretch',
          }}>
            {accountSizes.map((size) => {
              const priceRow = selectedModel.pricing.find(p => p.account_size === size);
              const price = priceRow?.is_active ? priceRow.price : null;
              const isSoldOut = !priceRow || price == null || priceRow.locked;
              const isUnlimited = !isSoldOut && priceRow.is_unlimited;
              const pct = isUnlimited
                ? 100
                : (priceRow?.slot_limit > 0
                    ? Math.max(0, Math.min(100, ((priceRow.remaining ?? 0) / priceRow.slot_limit) * 100))
                    : 0);
              const targets = Array.isArray(selectedModel.profit_targets_pct) ? selectedModel.profit_targets_pct : [];
              const isRecommended = size === RECOMMENDED_SIZE && !isSoldOut;
              const inverted = isRecommended;

              const inkColor = inverted ? 'var(--paper)' : 'var(--ink)';
              const mutedColor = inverted ? 'color-mix(in srgb, var(--paper) 65%, transparent)' : 'var(--muted)';
              const ruleColor = inverted ? 'color-mix(in srgb, var(--paper) 25%, transparent)' : 'var(--rule)';

              return (
                <div
                  key={size}
                  className={`mp-account-size-card ${!isSoldOut ? 'mp-active-selection' : ''}`}
                  style={{
                    background: isSoldOut ? 'var(--paper-2)' : inverted ? 'var(--ink)' : 'var(--glass)',
                    backdropFilter: isSoldOut || inverted ? undefined : 'blur(16px) saturate(140%)',
                    WebkitBackdropFilter: isSoldOut || inverted ? undefined : 'blur(16px) saturate(140%)',
                    boxShadow: isSoldOut ? undefined : 'var(--elev)',
                    border: `1px solid ${inverted ? 'var(--ink)' : 'var(--rule)'}`,
                    padding: 'var(--space-6) var(--space-5)',
                    display: 'flex',
                    flexDirection: 'column',
                    position: 'relative',
                    opacity: isSoldOut ? 0.55 : 1,
                  }}
                >
                  {isRecommended && (
                    <div style={{
                      position: 'absolute', top: '-11px', left: '50%', transform: 'translateX(-50%)',
                      background: 'var(--warn)', color: 'var(--ink)', fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)', fontWeight: 800, letterSpacing: '0.1em', padding: 'var(--space-1) var(--space-3)',
                      textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>
                      Recommended
                    </div>
                  )}

                  {/* Header row: ACCOUNT SIZE / PRICE */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)' }}>
                    <span style={{ fontSize: 'var(--fs-2xs)', color: mutedColor, textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                      Account Size
                    </span>
                    <span style={{ fontSize: 'var(--fs-2xs)', color: mutedColor, textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                      Price
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--space-1-5)' }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(22px,2.4vw,28px)', fontWeight: 800, color: isSoldOut ? 'var(--muted)' : inkColor }}>
                      ${size >= 1000 ? `${size / 1000}K` : size}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xl)', fontWeight: 800, color: isSoldOut ? 'var(--muted)' : inkColor }}>
                      {price != null ? `$${price}` : '—'}
                    </span>
                  </div>
                  <div style={{ marginBottom: 'var(--space-3-5)' }}>
                    <span style={{
                      display: 'inline-block', padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--fs-3xs)', fontWeight: 800, fontFamily: 'var(--font-mono)',
                      textTransform: 'uppercase', letterSpacing: '0.08em',
                      border: `1px solid ${isSoldOut ? 'var(--loss)' : pct > 50 ? 'var(--gain)' : 'var(--warn)'}`,
                      color: isSoldOut ? 'var(--loss)' : pct > 50 ? 'var(--gain)' : 'var(--warn)',
                    }}>
                      {isSoldOut ? 'FULL' : isUnlimited ? 'OPEN' : pct > 50 ? 'OPEN' : 'LOW'}
                    </span>
                    <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--fs-2xs)', color: mutedColor, fontFamily: 'var(--font-mono)' }}>
                      {sizeLabel(size)}
                    </span>
                  </div>

                  {/* Buy Challenge button */}
                  <button
                    type="button"
                    disabled={isSoldOut}
                    onClick={() => startChallenge(size)}
                    style={{
                      width: '100%',
                      padding: 'var(--space-3)',
                      marginBottom: 'var(--space-4-5)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-sm)',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      cursor: isSoldOut ? 'not-allowed' : 'pointer',
                      background: isSoldOut ? 'transparent' : inverted ? 'var(--paper)' : 'var(--ink)',
                      color: isSoldOut ? 'var(--muted)' : inverted ? 'var(--ink)' : 'var(--paper)',
                      border: `1px solid ${isSoldOut ? 'var(--rule)' : inverted ? 'var(--paper)' : 'var(--ink)'}`,
                    }}
                  >
                    {isSoldOut ? 'Full' : 'Buy Challenge'}
                  </button>

                  {/* Itemized rules */}
                  <div style={{ borderTop: `1px solid ${ruleColor}`, paddingTop: 'var(--space-3-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2-5)', flex: 1 }}>
                    <div>
                      <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 700, color: inkColor, marginBottom: 'var(--space-1)' }}>
                        Profit Target
                        <InfoDot title="The percentage gain required to pass this phase." />
                      </div>
                      {targets.map((t, i) => {
                        const phaseDays = Array.isArray(selectedModel.time_limits_days) ? selectedModel.time_limits_days[i] : null;
                        return (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)', color: mutedColor }}>
                            <span>Phase {i + 1}</span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: inkColor }}>
                              {t}%{phaseDays != null ? ` in ${phaseDays}d` : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)' }}>
                      <span style={{ color: inkColor, fontWeight: 700 }}>
                        Max Loss
                        <InfoDot title="Maximum drawdown allowed from your starting balance before the account is closed." />
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: inkColor }}>{selectedModel.max_drawdown_pct}%</span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)' }}>
                      <span style={{ color: inkColor, fontWeight: 700 }}>
                        Daily Loss
                        <InfoDot title="Maximum drawdown allowed within a single day." />
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: inkColor }}>{selectedModel.daily_drawdown_pct}%</span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)' }}>
                      <span style={{ color: inkColor, fontWeight: 700 }}>
                        Min Trading Days
                        <InfoDot title="Minimum number of days you must trade before completing this phase." />
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: inkColor }}>{selectedModel.min_trading_days}</span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)' }}>
                      <span style={{ color: inkColor, fontWeight: 700 }}>
                        Split
                        <InfoDot title="Your share of profits once funded, paid on this cadence." />
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: inkColor }}>
                        {selectedModel.profit_split_pct}% Weekly
                      </span>
                    </div>
                  </div>

                  {!isSoldOut && (
                    <div style={{ marginTop: 'var(--space-3-5)' }}>
                      <div style={{ height: '3px', background: ruleColor, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', width: `${pct}%`,
                          background: pct > 50 ? 'var(--gain)' : pct > 20 ? 'var(--warn)' : 'var(--loss)',
                          transition: 'width 0.6s ease',
                        }} />
                      </div>
                    </div>
                  )}

                  {isSoldOut && (
                    <div style={{ marginTop: 'var(--space-3-5)', fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>
                      {price == null ? 'Not offered at this size' : 'All slots claimed — check back soon'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
