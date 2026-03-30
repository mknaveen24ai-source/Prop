import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// All valid account sizes supported by the platform
const ALL_SIZES = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 200000];

/* Animated number counter */
function CountUp({ value, duration = 800 }) {
  const [display, setDisplay] = useState('0');
  const prevValue = useRef(0);

  useEffect(() => {
    const start = prevValue.current;
    const end = value;
    const startTime = performance.now();
    const animate = (now) => {
      const prog = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - prog, 3);
      const current = start + (end - start) * ease;
      setDisplay(Math.round(current).toLocaleString());
      if (prog < 1) requestAnimationFrame(animate);
      else prevValue.current = end;
    };
    requestAnimationFrame(animate);
  }, [value, duration]);

  return <>{display}</>;
}

function sizeLabel(size) {
  if (size >= 200000) return 'Institutional';
  if (size >= 100000) return 'Enterprise';
  if (size >= 50000)  return 'Elite';
  if (size >= 25000)  return 'Pro';
  if (size >= 10000)  return 'Standard';
  if (size >= 5000)   return 'Advanced';
  if (size >= 2500)   return 'Starter';
  return 'Micro';
}

// Merge API data with all valid sizes so every size always shows
function mergeWithDefaults(apiData) {
  return ALL_SIZES.map(size => {
    const found = apiData.find(a => Number(a.size) === size);
    if (found) return found;
    // Not in API response = admin hasn't set a quota = unavailable
    return {
      size,
      quota: 0,
      used: 0,
      remaining: 0,
      locked: true,
      reason: 'Not currently available.',
    };
  });
}

export default function LandingCalculator() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState(() => mergeWithDefaults([]));
  const [selected, setSelected] = useState(0);
  const [loadingAPI, setLoadingAPI] = useState(true);

  useEffect(() => {
    async function fetchSizes() {
      try {
        const res = await axios.get(`${API_URL}/api/accounts/available-sizes`, { timeout: 5000 });
        const merged = mergeWithDefaults(res.data);
        setAccounts(merged);
        // Auto-select the first unlocked size
        const firstUnlocked = merged.findIndex(s => !s.locked);
        if (firstUnlocked >= 0) setSelected(firstUnlocked);
      } catch {
        // Backend offline — show all sizes as locked until data loads
        setAccounts(mergeWithDefaults([]));
      } finally {
        setLoadingAPI(false);
      }
    }
    fetchSizes();
    const iv = setInterval(fetchSizes, 30000);
    return () => clearInterval(iv);
  }, []);

  const acc = accounts[selected];
  const isLocked = !acc || acc.locked || acc.quota === 0;
  const totalEnabled = accounts.filter(a => a.quota > 0).length;
  const totalRemaining = accounts.reduce((s, a) => s + (a.remaining || 0), 0);

  return (
    <section id="mp-accounts" className="mp-section" style={{
      background: 'linear-gradient(180deg, rgba(10,14,23,0.95), rgba(10,14,23,0.8))',
      borderTop: '1px solid rgba(255,255,255,0.04)',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      position: 'relative',
    }}>
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '800px', height: '800px', background: 'radial-gradient(circle, rgba(41,98,255,0.03), transparent 60%)', pointerEvents: 'none' }} />

      <div className="mp-container">
        <div style={{ textAlign: 'center', marginBottom: '60px' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: '20px' }}>
            <span className="mp-badge-dot"></span>
            Account Sizes
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">Choose Your Account Size</h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            All accounts are <span style={{ color: '#00c896', fontWeight: 700 }}>completely free</span>.
            Limited spots available each month, backed by real liquidity.
          </p>

          {/* Summary pill */}
          <div className="mp-reveal mp-delay-300" style={{ marginTop: '24px', display: 'inline-flex', gap: '24px', padding: '12px 28px', background: 'rgba(255,255,255,0.03)', borderRadius: '100px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.4)' }}>
              Sizes Available: <span style={{ color: '#fff', fontWeight: 600, fontFamily: 'DM Mono, monospace' }}>{totalEnabled}</span>
            </span>
            <span style={{ width: '1px', background: 'rgba(255,255,255,0.08)' }} />
            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.4)' }}>
              Open Slots: <span style={{ color: totalRemaining > 0 ? '#00c896' : '#f0b90b', fontWeight: 600, fontFamily: 'DM Mono, monospace' }}>{loadingAPI ? '...' : totalRemaining}</span>
            </span>
          </div>
        </div>

        {/* Account Cards Grid */}
        <div className="mp-reveal mp-delay-300" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: '14px',
          maxWidth: '1200px',
          margin: '0 auto 60px',
        }}>
          {accounts.map((a, i) => {
            const isSelected = selected === i;
            const isSoldOut = a.locked || a.quota === 0;
            const pct = a.quota > 0 ? Math.max(0, Math.min(100, ((a.remaining ?? 0) / a.quota) * 100)) : 0;
            const isUnlimited = a.quota >= 999999;

            return (
              <div
                key={i}
                onClick={() => setSelected(i)}
                className={isSelected && !isSoldOut ? 'mp-active-selection' : ''}
                style={{
                  background: isSoldOut
                    ? 'rgba(17,24,39,0.25)'
                    : isSelected
                      ? 'linear-gradient(135deg, rgba(41,98,255,0.18), rgba(123,97,255,0.12))'
                      : 'rgba(17,24,39,0.6)',
                  border: isSoldOut
                    ? '1px solid rgba(255,71,87,0.12)'
                    : isSelected
                      ? '1px solid rgba(41,98,255,0.5)'
                      : '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '20px',
                  padding: '24px 18px',
                  cursor: 'pointer',
                  transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                  textAlign: 'center',
                  transform: isSelected && !isSoldOut ? 'translateY(-6px) scale(1.02)' : 'translateY(0)',
                  boxShadow: isSelected && !isSoldOut ? '0 20px 48px rgba(41,98,255,0.25)' : 'none',
                  position: 'relative',
                  overflow: 'hidden',
                  opacity: isSoldOut ? 0.45 : 1,
                }}
              >
                {/* Reactive Border Pulse for Selection */}
                {isSelected && !isSoldOut && (
                  <div style={{ 
                    position: 'absolute', inset: 0, 
                    border: '2px solid var(--mp-accent)', 
                    borderRadius: '20px',
                    animation: 'mp-count-glow 2s infinite alternate',
                    pointerEvents: 'none'
                  }} />
                )}

                {/* Sold-out badge */}
                {isSoldOut && (
                  <div style={{
                    position: 'absolute', top: '12px', right: '12px',
                    padding: '3px 10px', borderRadius: '100px',
                    background: 'rgba(255,71,87,0.15)', border: '1px solid rgba(255,71,87,0.3)',
                    color: '#ff4757', fontSize: '9px', fontWeight: 800,
                    textTransform: 'uppercase', letterSpacing: '0.1em',
                    fontFamily: 'DM Mono, monospace',
                  }}>Full</div>
                )}

                <div style={{ fontSize: '10px', color: isSelected && !isSoldOut ? '#2962ff' : 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '10px', fontFamily: 'DM Mono, monospace', fontWeight: 700 }}>
                  {sizeLabel(a.size)}
                </div>
                <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 'clamp(20px,2vw,28px)', fontWeight: 800, color: isSoldOut ? 'rgba(255,255,255,0.25)' : '#fff', marginBottom: '14px' }}>
                  ${a.size.toLocaleString()}
                </div>

                {/* FREE / FULL badge */}
                <div style={{
                  display: 'inline-block', padding: '6px 16px',
                  background: isSoldOut ? 'rgba(255,71,87,0.1)' : 'rgba(0,200,150,0.1)',
                  border: `1px solid ${isSoldOut ? 'rgba(255,71,87,0.2)' : 'rgba(0,200,150,0.3)'}`,
                  borderRadius: '100px', color: isSoldOut ? '#ff4757' : '#00c896',
                  fontSize: '13px', fontWeight: 700, marginBottom: '16px',
                }}>
                  {isSoldOut ? 'SOLD OUT' : 'FREE'}
                </div>

                {/* Availability bar */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>AVAILABLE</span>
                    <span style={{ fontSize: '10px', color: isSoldOut ? '#ff4757' : pct > 50 ? '#00c896' : '#f0b90b', fontFamily: 'DM Mono, monospace', fontWeight: 700 }}>
                      {isSoldOut ? '0.00%' : isUnlimited ? '100%' : `${pct.toFixed(1)}%`}
                    </span>
                  </div>
                  <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: isUnlimited ? '100%' : `${pct}%`,
                      background: isSoldOut ? '#ff4757' : pct > 50 ? '#00c896' : pct > 20 ? '#f0b90b' : '#ff4757',
                      borderRadius: '4px', transition: 'width 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
                      boxShadow: isSelected ? `0 0 10px ${isSoldOut ? '#ff4757' : pct > 50 ? '#00c896' : '#f0b90b'}` : 'none'
                    }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Detail Panel */}
        {acc && (
          <div className="mp-glass-card mp-reveal mp-delay-400" style={{ maxWidth: '900px', margin: '0 auto', padding: '56px', background: 'rgba(17,24,39,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '48px' }}>

              <div style={{ flex: 1, minWidth: '300px' }}>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '12px', fontFamily: 'DM Mono, monospace', fontWeight: 700 }}>Active Tier Assessment</div>
                <div style={{ fontFamily: 'Sora, sans-serif', fontSize: '56px', fontWeight: 800, color: isLocked ? 'rgba(255,255,255,0.25)' : '#fff', marginBottom: '32px', letterSpacing: '-0.02em' }}>
                  $<CountUp value={acc.size} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px' }}>
                  {[
                    { label: 'Evaluation Fee', value: isLocked ? 'Locked' : '0.00 USD',     color: isLocked ? '#ff4757' : '#00c896', isShimmer: !isLocked },
                    { label: 'Evaluation Mode', value: 'Phase 1 + 2',                      color: '#2962ff' },
                    { label: 'Standard Leverage',value: '1:30 (Max)',                      color: '#fff' },
                    { label: 'Availability',   value: isLocked ? 'Closed' : acc.quota >= 999999 ? 'Institutional' : 'Limited Spots', color: isLocked ? '#ff4757' : '#f0b90b' },
                  ].map((item, i) => (
                    <div key={i} style={{ padding: '16px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginBottom: '6px', fontWeight: 600 }}>{item.label}</div>
                      <div className={item.isShimmer ? 'mp-shimmer' : ''} style={{ fontSize: '17px', fontWeight: 700, color: item.color }}>{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Circular indicator */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '28px', flex: '0 0 auto' }}>
                {(() => {
                  const isUnlim = acc.quota >= 999999;
                  const availPct = isUnlim ? 100 : acc.quota > 0 ? Math.max(0, Math.min(100, ((acc.remaining ?? 0) / acc.quota) * 100)) : 0;
                  const ringColor = isLocked ? '#ff4757' : availPct > 50 ? '#00c896' : availPct > 20 ? '#f0b90b' : '#ff4757';
                  const glowColor = isLocked ? 'rgba(255,71,87,0.2)' : availPct > 50 ? 'rgba(0,200,150,0.2)' : 'rgba(240,185,11,0.2)';
                  
                  return (
                    <div style={{ 
                      width: '180px', height: '180px', 
                      borderRadius: '50%', 
                      border: '4px solid rgba(255,255,255,0.04)', 
                      display: 'flex', flexDirection: 'column', alignItems: 'center', 
                      justifyContent: 'center', position: 'relative',
                      boxShadow: `0 0 40px ${glowColor}`,
                      transition: 'all 0.5s ease'
                    }}>
                      <svg width="180" height="180" viewBox="0 0 180 180" style={{ position: 'absolute', top: 0, left: 0, transform: 'rotate(-90deg)' }}>
                        <circle cx="90" cy="90" r="84" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="6" />
                        <circle cx="90" cy="90" r="84" fill="none"
                          stroke={ringColor} strokeWidth="6"
                          strokeDasharray={`${(availPct / 100) * 527.8} 527.8`}
                          strokeLinecap="round"
                          style={{ transition: 'stroke-dasharray 1s cubic-bezier(0.16, 1, 0.3, 1)' }}
                        />
                      </svg>
                      <div style={{ fontFamily: 'Sora, sans-serif', fontSize: '38px', fontWeight: 800, color: '#fff', zIndex: 1, letterSpacing: '-0.02em' }}>
                        {isLocked ? '0' : isUnlim ? '∞' : (acc.remaining ?? 0)}
                      </div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', zIndex: 1, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                        {isLocked ? 'Sold Out' : 'Active Slots'}
                      </div>
                    </div>
                  );
                })()}

                {isLocked ? (
                  <div style={{ padding: '20px 40px', borderRadius: '16px', background: 'rgba(255,71,87,0.08)', border: '1px solid rgba(255,71,87,0.2)', color: '#ff4757', fontWeight: 700, fontSize: '15px', textAlign: 'center' }}>
                    QUOTA EXCEEDED
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '8px', fontWeight: 400 }}>Next release in 14 days</div>
                  </div>
                ) : (
                  <>
                    <button className="mp-btn-primary" style={{ padding: '22px 48px', minWidth: '240px' }} onClick={() => navigate('/register')}>
                      Start Assessment
                    </button>
                    <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', textAlign: 'center', fontWeight: 500 }}>Immediate institutional access</p>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
