export const MASTERPIECE_CSS = `
  /* 
   ==========================================================================
   MASTERPIECE LANDING PAGE — Color Psychology + 3D + Premium Design System
   Deep Navy (authority) · Electric Blue (trust) · Gold (wealth) · Emerald (growth)
   ==========================================================================
  */
  @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&family=Sora:wght@300;400;500;600;700;800&family=DM+Mono:wght@300;400;500&display=swap');

  :root {
    /* — Color Psychology Palette — */
    --mp-navy-deep: #0a0e17;
    --mp-navy-mid: #0d1220;
    --mp-navy-card: #111827;
    --mp-navy-elevated: #1a2332;

    --mp-accent: #2962ff;
    --mp-accent-bright: #4d82ff;
    --mp-accent-glow: rgba(41, 98, 255, 0.25);
    --mp-accent-subtle: rgba(41, 98, 255, 0.08);

    --mp-gold: #f0b90b;
    --mp-gold-light: #fcd535;
    --mp-gold-glow: rgba(240, 185, 11, 0.25);
    --mp-gold-subtle: rgba(240, 185, 11, 0.08);

    --mp-emerald: #00c896;
    --mp-emerald-light: #34e0b0;
    --mp-emerald-glow: rgba(0, 200, 150, 0.25);

    --mp-lavender: #7b61ff;
    --mp-lavender-glow: rgba(123, 97, 255, 0.2);

    --mp-red: #ff4757;
    --mp-red-glow: rgba(255, 71, 87, 0.2);

    --mp-cyan: #00e5ff;
    --mp-cyan-glow: rgba(0, 229, 255, 0.2);

    --mp-border: rgba(255, 255, 255, 0.06);
    --mp-border-hover: rgba(255, 255, 255, 0.12);
    --mp-border-glow: rgba(255, 255, 255, 0.18);

    --mp-text: #ffffff;
    --mp-text-secondary: rgba(255, 255, 255, 0.75);
    --mp-text-muted: rgba(255, 255, 255, 0.50);
    --mp-text-dim: rgba(255, 255, 255, 0.30);

    --mp-glass-bg: rgba(17, 24, 39, 0.60);
    --mp-glass-bg-solid: rgba(17, 24, 39, 0.85);
    --mp-glass-blur: blur(24px);

    --mp-gradient-hero: linear-gradient(135deg, #2962ff 0%, #7b61ff 50%, #00c896 100%);
    --mp-gradient-gold: linear-gradient(135deg, #f0b90b 0%, #fcd535 100%);
    --mp-gradient-text: linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.65) 100%);
    --mp-gradient-blue: linear-gradient(135deg, #2962ff 0%, #4d82ff 100%);
  }

  /* ══ RESET & BASE ══ */
  .masterpiece-landing {
    background: var(--mp-navy-deep);
    color: var(--mp-text);
    font-family: 'Manrope', sans-serif;
    overflow-x: hidden;
    position: relative;
    width: 100%;
    min-height: 100vh;
  }

  .masterpiece-landing * {
    box-sizing: border-box;
  }

  /* ══ BACKGROUND SYSTEM ══ */
  .mp-bg-system {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    pointer-events: none;
    z-index: 0;
    overflow: hidden;
  }

  .mp-bg-noise {
    position: absolute;
    inset: 0;
    opacity: 0.15;
    pointer-events: none;
    filter: url(#mp-noise);
    z-index: 1;
  }

  .mp-bg-orb-1 {
    position: absolute;
    top: -25vh; left: -15vw;
    width: 70vw; height: 70vw;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(41, 98, 255, 0.16) 0%, rgba(123, 97, 255, 0.08) 40%, transparent 70%);
    filter: url(#mp-liquid) blur(60px);
    animation: mp-liquid-move 35s ease-in-out infinite alternate;
  }

  .mp-bg-orb-2 {
    position: absolute;
    bottom: -30vh; right: -15vw;
    width: 80vw; height: 80vw;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(0, 200, 150, 0.1) 0%, rgba(240, 185, 11, 0.05) 40%, transparent 70%);
    filter: url(#mp-liquid) blur(70px);
    animation: mp-liquid-move-reverse 40s ease-in-out infinite alternate-reverse;
  }

  .mp-bg-grid {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(to right, rgba(255,255,255,0.02) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255,255,255,0.02) 1px, transparent 1px);
    background-size: 80px 80px;
    mask-image: radial-gradient(ellipse at center, black 40%, transparent 85%);
    -webkit-mask-image: radial-gradient(ellipse at center, black 40%, transparent 85%);
    transform: perspective(1000px) rotateX(15deg) scale(1.1);
    transform-origin: top;
    opacity: 0.5;
  }

  /* ══ TYPOGRAPHY ══ */
  .mp-h1 {
    font-family: 'Sora', sans-serif;
    font-size: clamp(48px, 8vw, 96px);
    font-weight: 800;
    line-height: 1.05;
    letter-spacing: -0.03em;
    background: var(--mp-gradient-text);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 24px;
  }
  
  .mp-h2 {
    font-family: 'Sora', sans-serif;
    font-size: clamp(36px, 5vw, 64px);
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.02em;
    margin-bottom: 20px;
    color: var(--mp-text);
  }

  .mp-h3 {
    font-family: 'Sora', sans-serif;
    font-size: clamp(22px, 3vw, 32px);
    font-weight: 600;
    line-height: 1.2;
    margin-bottom: 16px;
    color: var(--mp-text);
  }

  .mp-p-lead {
    font-size: clamp(18px, 2vw, 22px);
    color: var(--mp-text-secondary);
    line-height: 1.7;
    max-width: 720px;
    margin-bottom: 40px;
  }

  .mp-p-body {
    font-size: 16px;
    color: var(--mp-text-muted);
    line-height: 1.7;
  }

  /* ══ GLOW TEXT ══ */
  .mp-glow-text {
    background: linear-gradient(135deg, var(--mp-gold), var(--mp-gold-light));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    filter: drop-shadow(0 0 20px var(--mp-gold-glow));
  }

  .mp-text-emerald {
    color: var(--mp-emerald);
    text-shadow: 0 0 20px var(--mp-emerald-glow);
  }

  /* ══ BUTTONS ══ */
  .mp-btn-primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 18px 40px;
    background: var(--mp-gradient-blue);
    color: #fff;
    font-family: 'Sora', sans-serif;
    font-size: 16px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border-radius: 14px;
    text-decoration: none;
    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    border: none;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(41, 98, 255, 0.35), inset 0 1px 0 rgba(255,255,255,0.1);
  }

  .mp-btn-primary::before {
    content: '';
    position: absolute;
    top: 0; left: -100%;
    width: 100%; height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
    transition: left 0.6s ease;
  }

  .mp-btn-primary:hover {
    transform: translateY(-3px) scale(1.02);
    box-shadow: 0 16px 48px rgba(41, 98, 255, 0.5), inset 0 1px 0 rgba(255,255,255,0.15);
  }

  .mp-btn-primary:hover::before {
    left: 100%;
  }

  .mp-btn-secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 16px 36px;
    background: rgba(255,255,255,0.04);
    color: var(--mp-text);
    font-family: 'Sora', sans-serif;
    font-size: 16px;
    font-weight: 500;
    border-radius: 14px;
    border: 1px solid var(--mp-border);
    transition: all 0.3s ease;
    cursor: pointer;
    backdrop-filter: blur(10px);
  }

  .mp-btn-secondary:hover {
    background: rgba(255,255,255,0.08);
    border-color: var(--mp-border-glow);
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  }

  /* ══ GLASS CARD ══ */
  .mp-glass-card {
    background: var(--mp-glass-bg);
    backdrop-filter: var(--mp-glass-blur);
    -webkit-backdrop-filter: var(--mp-glass-blur);
    border: 1px solid var(--mp-border);
    border-radius: 24px;
    padding: 40px;
    transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
  }

  .mp-glass-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
  }

  .mp-glass-card::after {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(600px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(41, 98, 255, 0.06), transparent 40%);
    opacity: 0;
    transition: opacity 0.4s;
    pointer-events: none;
    border-radius: 24px;
  }

  .mp-glass-card:hover {
    border-color: var(--mp-border-hover);
    transform: translateY(-6px);
    box-shadow: 0 24px 64px rgba(0,0,0,0.4), 0 0 0 1px rgba(41, 98, 255, 0.05);
  }
  
  .mp-glass-card:hover::after {
    opacity: 1;
  }

  /* ══ BADGE ══ */
  .mp-badge {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 8px 18px;
    background: linear-gradient(135deg, rgba(41, 98, 255, 0.1), rgba(123, 97, 255, 0.08));
    border: 1px solid rgba(41, 98, 255, 0.2);
    border-radius: 100px;
    color: var(--mp-accent-bright);
    font-family: 'DM Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .mp-badge-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--mp-emerald);
    box-shadow: 0 0 12px var(--mp-emerald), 0 0 24px var(--mp-emerald-glow);
    animation: mp-pulse 2s infinite;
  }

  /* ══ LAYOUT ══ */
  .mp-container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 24px;
    position: relative;
    z-index: 10;
  }

  .mp-section {
    padding: 140px 0;
    position: relative;
  }

  .mp-section-divider {
    width: 100%;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--mp-border-hover), transparent);
    margin: 0;
  }

  /* ══ ANIMATIONS ══ */
  @keyframes mp-liquid-move {
    0% { transform: translate(0, 0) scale(1); border-radius: 50% 50% 50% 70%; }
    33% { transform: translate(5%, 10%) scale(1.1); border-radius: 40% 60% 70% 30%; }
    66% { transform: translate(-5%, 15%) scale(0.9); border-radius: 70% 30% 40% 60%; }
    100% { transform: translate(3%, 5%) scale(1.05); border-radius: 50% 50% 70% 50%; }
  }

  @keyframes mp-liquid-move-reverse {
    0% { transform: translate(0, 0) scale(1); border-radius: 50% 70% 50% 50%; }
    50% { transform: translate(-8%, -12%) scale(1.15); border-radius: 70% 30% 30% 70%; }
    100% { transform: translate(-3%, -5%) scale(1.02); border-radius: 50% 70% 50% 50%; }
  }

  @keyframes mp-shimmer-text {
    0% { background-position: -200% center; }
    100% { background-position: 200% center; }
  }

  .mp-shimmer {
    background: linear-gradient(
      90deg, 
      transparent 0%, 
      rgba(255,255,255,0.2) 20%, 
      rgba(255,255,255,0.5) 50%, 
      rgba(255,255,255,0.2) 80%, 
      transparent 100%
    );
    background-size: 200% auto;
    -webkit-background-clip: text;
    background-clip: text;
    animation: mp-shimmer-text 4s linear infinite;
  }

  /* ══ REVEAL SYSTEM ══ */
  .mp-reveal {
    opacity: 0;
    transform: translateY(40px);
    transition: all 0.9s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .mp-reveal.mp-active {
    opacity: 1;
    transform: translateY(0);
  }
  .mp-delay-100 { transition-delay: 100ms; }
  .mp-delay-200 { transition-delay: 200ms; }
  .mp-delay-300 { transition-delay: 300ms; }
  .mp-delay-400 { transition-delay: 400ms; }
  .mp-delay-500 { transition-delay: 500ms; }
  .mp-delay-600 { transition-delay: 600ms; }
  .mp-delay-700 { transition-delay: 700ms; }

  /* ══ BENTO GRID ══ */
  .mp-bento-grid {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 24px;
    grid-auto-rows: 280px;
  }

  .mp-bento-item {
    background: var(--mp-glass-bg);
    border: 1px solid var(--mp-border);
    border-radius: 24px;
    padding: 40px;
    position: relative;
    overflow: hidden;
    backdrop-filter: var(--mp-glass-blur);
    transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    cursor: default;
  }

  .mp-bento-item::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
    transition: opacity 0.5s;
  }

  .mp-bento-item::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(41, 98, 255, 0.04) 0%, transparent 60%);
    opacity: 0;
    transition: opacity 0.5s ease;
    pointer-events: none;
    border-radius: 24px;
  }

  .mp-bento-item:hover {
    border-color: rgba(41, 98, 255, 0.15);
    transform: translateY(-6px) scale(1.01);
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }

  .mp-bento-item:hover::after { opacity: 1; }

  /* ══ MASONRY WALL ══ */
  .mp-masonry {
    column-count: 1;
    column-gap: 20px;
  }
  @media (min-width: 768px) { .mp-masonry { column-count: 2; } }
  @media (min-width: 1024px) { .mp-masonry { column-count: 3; } }
  @media (min-width: 1440px) { .mp-masonry { column-count: 4; } }

  .mp-masonry-item {
    break-inside: avoid;
    margin-bottom: 20px;
  }

  /* ══ CALCULATOR SLIDER ══ */
  .mp-slider {
    -webkit-appearance: none;
    width: 100%;
    height: 6px;
    background: rgba(255,255,255,0.08);
    border-radius: 3px;
    outline: none;
    margin: 20px 0;
    transition: background 0.2s;
  }
  .mp-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--mp-gradient-blue);
    cursor: pointer;
    box-shadow: 0 0 20px var(--mp-accent-glow), 0 4px 12px rgba(0,0,0,0.3);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    border: 3px solid rgba(255,255,255,0.2);
  }
  .mp-slider::-webkit-slider-thumb:hover {
    transform: scale(1.2);
    box-shadow: 0 0 30px var(--mp-accent-glow), 0 6px 16px rgba(0,0,0,0.4);
  }

  /* ══ FAQ ACCORDION ══ */
  .mp-faq-item {
    border-bottom: 1px solid var(--mp-border);
    transition: background 0.3s;
  }
  .mp-faq-item:hover {
    background: rgba(255,255,255,0.01);
  }
  .mp-faq-btn {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 28px 0;
    background: none;
    border: none;
    color: var(--mp-text);
    font-size: 22px;
    font-family: 'Sora', sans-serif;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    transition: color 0.3s;
  }
  .mp-faq-btn:hover { color: var(--mp-accent-bright); }
  .mp-faq-icon {
    width: 36px; height: 36px;
    border-radius: 50%;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--mp-border);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    flex-shrink: 0;
  }
  .mp-faq-item.active .mp-faq-icon {
    transform: rotate(180deg);
    background: var(--mp-accent-subtle);
    border-color: rgba(41, 98, 255, 0.3);
    color: var(--mp-accent);
  }
  .mp-faq-content {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.6s cubic-bezier(0.16, 1, 0.3, 1), padding 0.6s ease;
  }
  .mp-faq-item.active .mp-faq-content {
    max-height: 500px;
    padding-bottom: 28px;
  }

  /* ══ TIMELINE / SCALING ══ */
  .mp-timeline {
    position: relative;
    max-width: 1000px;
    margin: 0 auto;
  }
  .mp-timeline::before {
    content: '';
    position: absolute;
    top: 50px; bottom: 50px;
    left: 40px;
    width: 2px;
    background: linear-gradient(to bottom, transparent, var(--mp-accent), var(--mp-emerald), var(--mp-gold), transparent);
  }
  .mp-timeline-item {
    display: flex;
    gap: 60px;
    margin-bottom: 60px;
    position: relative;
  }
  .mp-timeline-marker {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: var(--mp-navy-deep);
    border: 2px solid var(--mp-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    font-weight: 700;
    font-family: 'Sora', sans-serif;
    color: var(--mp-accent-bright);
    box-shadow: 0 0 30px var(--mp-accent-glow), inset 0 0 20px rgba(41, 98, 255, 0.05);
    z-index: 2;
    flex-shrink: 0;
    transition: all 0.4s ease;
  }
  .mp-timeline-marker:hover {
    border-color: var(--mp-gold);
    color: var(--mp-gold);
    box-shadow: 0 0 30px var(--mp-gold-glow), inset 0 0 20px rgba(240, 185, 11, 0.05);
  }
  .mp-timeline-content {
    flex-grow: 1;
    padding-top: 10px;
  }

  /* ══ RESPONSIVE ══ */
  @media (max-width: 1024px) {
    .mp-bento-grid { grid-template-columns: repeat(6, 1fr); grid-auto-rows: 240px; }
  }
  @media (max-width: 768px) {
    .mp-h1 { font-size: 38px; }
    .mp-h2 { font-size: 30px; }
    .mp-section { padding: 80px 0; }
    .mp-bento-grid { grid-template-columns: 1fr; grid-auto-rows: auto; }
    .mp-timeline::before { left: 30px; }
    .mp-timeline-marker { width: 60px; height: 60px; font-size: 18px; }
    .mp-timeline-item { gap: 24px; flex-direction: column; }
    .mp-timeline-marker { position: absolute; top: 0; left: 0; }
    .mp-timeline-content { padding-left: 90px; }
    .mp-glass-card { padding: 24px; border-radius: 16px; }
    .mp-bento-item { padding: 24px; border-radius: 16px; }
  }

  /* ══ 3D HERO CANVAS ══ */
  .mp-hero-canvas {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    z-index: 1;
    pointer-events: none;
  }

  /* ══ FLOATING 3D SHAPES ══ */
  .mp-float-shape {
    position: absolute;
    pointer-events: none;
    opacity: 0.15;
    animation: mp-float-shape 8s ease-in-out infinite;
  }

  .mp-float-shape-1 {
    top: 15%; right: 8%;
    width: 120px; height: 120px;
    border: 2px solid var(--mp-accent);
    border-radius: 20px;
    transform: rotate(45deg);
    animation-delay: 0s;
    animation-duration: 10s;
  }

  .mp-float-shape-2 {
    top: 60%; right: 15%;
    width: 80px; height: 80px;
    border: 2px solid var(--mp-gold);
    border-radius: 50%;
    animation-delay: -3s;
    animation-duration: 12s;
  }

  .mp-float-shape-3 {
    top: 35%; right: 25%;
    width: 60px; height: 60px;
    background: linear-gradient(135deg, rgba(0, 200, 150, 0.15), transparent);
    border-radius: 12px;
    animation-delay: -5s;
    animation-duration: 9s;
  }

  /* ══ STAT COUNTER ══ */
  .mp-stat-counter {
    display: flex;
    gap: 48px;
    flex-wrap: wrap;
    align-items: center;
    margin-top: 60px;
  }

  .mp-stat-item {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .mp-stat-number {
    font-family: 'DM Mono', monospace;
    font-size: 14px;
    font-weight: 600;
    color: var(--mp-text-secondary);
  }

  .mp-stat-divider {
    width: 1px;
    height: 28px;
    background: var--(mp-border-hover);
    background: rgba(255,255,255,0.12);
  }

  /* ══ SCROLL INDICATOR ══ */
  @keyframes mp-scroll-bounce {
    0%, 100% { transform: translateY(0); opacity: 0.5; }
    50% { transform: translateY(8px); opacity: 1; }
  }
`;
