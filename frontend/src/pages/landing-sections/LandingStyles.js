export const MASTERPIECE_CSS = `
  /*
   ==========================================================================
   THE LEDGER DESK — Public Landing Page
   Flat, hairline-ruled, printed-statement design system. No gradients, no
   glass/blur, no glow, no 3D transforms — hierarchy comes from rules and
   type, not elevation. Colors are sourced entirely from tokens.css so the
   page re-themes correctly across light (Rag Cotton White) and dark
   (Charcoal Noir).
   ==========================================================================
  */
  .mode-public,
  .masterpiece-landing {
    --mp-navy-deep: var(--color-bg-deep);
    --mp-navy-mid: var(--color-bg-subtle);
    --mp-navy-card: var(--color-surface-solid);
    --mp-navy-elevated: var(--color-surface-elevated);

    --mp-accent: var(--ink);
    --mp-accent-bright: var(--ink);
    --mp-accent-glow: transparent;
    --mp-accent-subtle: var(--paper-2);

    --mp-gold: var(--warn);
    --mp-gold-light: var(--warn);
    --mp-gold-glow: transparent;
    --mp-gold-subtle: var(--paper-2);

    --mp-emerald: var(--gain);
    --mp-emerald-light: var(--gain);
    --mp-emerald-glow: transparent;

    --mp-lavender: var(--muted);
    --mp-lavender-glow: transparent;

    --mp-red: var(--loss);
    --mp-red-glow: transparent;

    --mp-cyan: var(--muted);
    --mp-cyan-glow: transparent;

    --mp-border: var(--rule);
    --mp-border-hover: var(--ink);
    --mp-border-glow: var(--ink);

    --mp-text: var(--ink);
    --mp-text-secondary: var(--muted);
    --mp-text-muted: var(--muted);
    --mp-text-dim: var(--muted);

    --mp-glass-bg: var(--glass);
    --mp-glass-bg-solid: var(--paper-2);
    --mp-glass-blur: blur(20px) saturate(140%);
    --mp-glass-border: var(--rule-soft);
  }

  /* ══ RESET & BASE ══ */
  /* Halftone "print plate" backdrop — same device as the auth shell, so
     glass surfaces scrolling over this page have something to frost
     instead of a flat tint. Dot colors reuse gain/loss/warn, no new hues. */
  .masterpiece-landing {
    background-color: var(--paper);
    background-image:
      radial-gradient(circle, color-mix(in srgb, var(--warn) 70%, transparent) 1.6px, transparent 1.7px),
      radial-gradient(circle, color-mix(in srgb, var(--gain) 55%, transparent) 1.4px, transparent 1.5px),
      radial-gradient(circle, color-mix(in srgb, var(--loss) 55%, transparent) 1.4px, transparent 1.5px);
    background-size: 26px 26px, 34px 34px, 40px 40px;
    background-position: 0 0, 9px 14px, 21px 5px;
    background-attachment: fixed;
    color: var(--mp-text);
    font-family: var(--font-ui);
    overflow-x: hidden;
    position: relative;
    width: 100%;
    min-height: 100vh;
    padding-top: var(--risk-warning-height, 0px);
  }

  .masterpiece-landing * {
    box-sizing: border-box;
  }

  /* ══ TYPOGRAPHY ══ */
  .mp-h1 {
    font-family: var(--font-display-alt);
    font-size: clamp(48px, 8vw, 96px);
    font-weight: 700;
    line-height: 1.05;
    letter-spacing: -0.01em;
    color: var(--mp-text);
    margin-bottom: 24px;
  }

  .mp-h2 {
    font-family: var(--font-display);
    font-size: clamp(36px, 5vw, 64px);
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.01em;
    margin-bottom: 20px;
    color: var(--mp-text);
  }

  .mp-h3 {
    font-family: var(--font-display);
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

  /* ══ EMPHASIS TEXT (flat ink, no glow/shimmer) ══ */
  .mp-glow-text {
    color: var(--mp-gold);
  }

  .mp-text-emerald {
    color: var(--mp-emerald);
  }

  /* ══ BUTTONS ══ */
  .mp-btn-primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 18px 40px;
    background: var(--ink);
    color: var(--paper);
    font-family: var(--font-mono);
    font-size: 16px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-decoration: none;
    transition: opacity 0.2s ease;
    border: 1px solid var(--ink);
    cursor: pointer;
  }

  .mp-btn-primary:hover {
    opacity: 0.85;
  }

  .mp-btn-secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 16px 36px;
    background: transparent;
    color: var(--mp-text);
    font-family: var(--font-mono);
    font-size: 16px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border: 1px solid var(--mp-border);
    transition: border-color 0.2s ease;
    cursor: pointer;
  }

  .mp-btn-secondary:hover {
    border-color: var(--mp-border-hover);
  }

  /* ══ GLASS CARD ══ */
  .mp-glass-card {
    background: var(--mp-glass-bg);
    border: 1px solid var(--mp-glass-border);
    backdrop-filter: var(--mp-glass-blur);
    -webkit-backdrop-filter: var(--mp-glass-blur);
    padding: 40px;
    transition: border-color 0.3s ease;
    position: relative;
    overflow: hidden;
  }

  .mp-glass-card:hover {
    border-color: var(--mp-border-hover);
  }

  /* ══ BADGE ══ */
  .mp-badge {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 8px 18px;
    background: var(--mp-glass-bg);
    backdrop-filter: var(--mp-glass-blur);
    -webkit-backdrop-filter: var(--mp-glass-blur);
    border: 1px solid var(--mp-glass-border);
    color: var(--mp-accent-bright);
    font-family: var(--font-mono);
    font-size: 13px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .mp-badge-dot {
    display: none;
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

  .masterpiece-landing [id] {
    scroll-margin-top: calc(120px + var(--risk-warning-height, 0px));
  }

  .mp-section-divider {
    width: 100%;
    height: 1px;
    background: var(--mp-border);
    margin: 0;
  }

  /* ══ REVEAL SYSTEM ══ */
  .mp-reveal {
    opacity: 0;
    transform: translateY(16px);
    transition: opacity 0.6s ease, transform 0.6s ease;
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
    border: 1px solid var(--mp-glass-border);
    backdrop-filter: var(--mp-glass-blur);
    -webkit-backdrop-filter: var(--mp-glass-blur);
    padding: 40px;
    position: relative;
    overflow: hidden;
    transition: border-color 0.3s ease;
    cursor: default;
  }

  .mp-bento-item:hover {
    border-color: var(--mp-border-hover);
  }

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
    height: 2px;
    background: var(--mp-border);
    outline: none;
    margin: 20px 0;
  }
  .mp-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--ink);
    cursor: pointer;
    border: 3px solid var(--paper);
    box-shadow: 0 0 0 1px var(--ink);
  }

  /* ══ FAQ ACCORDION ══ */
  .mp-faq-item {
    border-bottom: 1px solid var(--mp-border);
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
    font-family: var(--font-display);
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    transition: color 0.3s;
  }
  .mp-faq-btn:hover { color: var(--mp-accent-bright); }
  .mp-faq-icon {
    width: 36px; height: 36px;
    border-radius: 50%;
    background: transparent;
    border: 1px solid var(--mp-border);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.3s ease, border-color 0.3s ease, color 0.3s ease;
    flex-shrink: 0;
  }
  .mp-faq-item.active .mp-faq-icon {
    transform: rotate(180deg);
    border-color: var(--ink);
    color: var(--mp-accent);
  }
  .mp-faq-content {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.5s ease, padding 0.5s ease;
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
    width: 1px;
    background: var(--mp-border);
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
    background: var(--paper);
    border: 2px solid var(--mp-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--mp-accent-bright);
    z-index: 2;
    flex-shrink: 0;
    transition: border-color 0.3s ease, color 0.3s ease;
  }
  .mp-timeline-marker:hover {
    border-color: var(--mp-gold);
    color: var(--mp-gold);
  }
  .mp-timeline-content {
    flex-grow: 1;
    padding-top: 10px;
  }

  /* ══ RESPONSIVE ══ */
  @media (max-width: 1024px) {
    .mp-bento-grid { grid-template-columns: repeat(6, 1fr); grid-auto-rows: 240px; }
    .mp-hero {
      min-height: auto !important;
      padding-top: calc(104px + var(--risk-warning-height, 0px)) !important;
      padding-bottom: 78px !important;
    }
  }
  @media (max-width: 768px) {
    .mp-h1 { font-size: 38px; }
    .mp-h2 { font-size: 30px; }
    .mp-section { padding: 80px 0; }
    .mp-p-lead {
      font-size: 16px;
      line-height: 1.65;
      margin-bottom: 28px;
    }
    .mp-badge {
      max-width: 100%;
      white-space: normal;
      line-height: 1.45;
      font-size: 11px;
    }
    .mp-stat-counter {
      width: 100%;
      align-items: stretch !important;
      gap: 10px !important;
    }
    .mp-stat-item {
      width: 100%;
      justify-content: flex-start;
    }
    .mp-stat-divider {
      display: none;
    }
    .mp-bento-grid { grid-template-columns: 1fr; grid-auto-rows: auto; }
    .mp-feature-grid {
      grid-template-columns: 1fr !important;
      gap: 18px !important;
    }
    .mp-feature-card {
      grid-column: 1 / -1 !important;
      min-height: auto !important;
      padding: 28px !important;
    }
    .mp-feature-card > div:first-child {
      width: 64px !important;
      height: 64px !important;
      margin-bottom: 22px !important;
    }
    .mp-feature-card svg {
      width: 34px;
      height: 34px;
    }
    .mp-feature-card .mp-h3 {
      font-size: 21px !important;
      margin-bottom: 10px !important;
    }
    .mp-feature-card .mp-p-body {
      font-size: 14px !important;
      line-height: 1.65 !important;
    }
    .mp-account-size-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      gap: 12px !important;
      margin-bottom: 36px !important;
    }
    .mp-account-size-card {
      padding: 18px 12px !important;
      transform: none !important;
    }
    .mp-account-detail-card {
      padding: 28px !important;
    }
    .mp-account-detail-layout {
      gap: 28px !important;
    }
    .mp-account-detail-main {
      min-width: 0 !important;
      width: 100%;
    }
    .mp-availability-pill {
      width: 100%;
      justify-content: space-between;
      gap: 10px !important;
      padding: 12px 16px !important;
    }
    .mp-timeline::before { left: 30px; }
    .mp-timeline-marker { width: 60px; height: 60px; font-size: 18px; }
    .mp-timeline-item { gap: 24px; flex-direction: column; }
    .mp-timeline-marker { position: absolute; top: 0; left: 0; }
    .mp-timeline-content { padding-left: 90px; }
    .mp-glass-card { padding: 24px; }
    .mp-bento-item { padding: 24px; }
    .mp-faq-btn {
      gap: 16px;
      padding: 22px 0;
      font-size: 18px;
      line-height: 1.35;
    }
    .mp-faq-icon {
      width: 32px;
      height: 32px;
    }
  }

  @media (max-width: 640px) {
    .mp-container {
      padding-left: 16px;
      padding-right: 16px;
    }

    .mp-h1 {
      font-size: clamp(34px, 10vw, 42px) !important;
      line-height: 1.08;
      letter-spacing: -0.02em;
    }

    .mp-h2 {
      font-size: clamp(28px, 8vw, 34px) !important;
    }

    .mp-section {
      padding: 64px 0 !important;
    }

    .mp-hero {
      padding-top: calc(88px + var(--risk-warning-height, 0px)) !important;
      padding-bottom: 54px !important;
    }

    .mp-btn-primary,
    .mp-btn-secondary {
      width: 100%;
      min-height: 48px;
      padding: 14px 18px !important;
      justify-content: center;
      font-size: 13px !important;
      letter-spacing: 0.04em;
    }

    .mp-feature-grid {
      grid-template-columns: 1fr !important;
      gap: 14px !important;
    }

    .mp-feature-card {
      grid-column: 1 / -1 !important;
      padding: 22px !important;
      min-height: auto !important;
    }

    .mp-feature-card > div:first-child {
      width: 56px !important;
      height: 56px !important;
      margin-bottom: 18px !important;
      transform: none !important;
    }

    .mp-feature-card svg {
      width: 30px;
      height: 30px;
    }

    .mp-feature-card .mp-h3 {
      font-size: 20px !important;
      margin-bottom: 10px !important;
      transform: none !important;
    }

    .mp-feature-card .mp-p-body {
      font-size: 14px !important;
      line-height: 1.6 !important;
      transform: none !important;
    }

    .mp-account-size-grid {
      grid-template-columns: 1fr !important;
      gap: 10px !important;
      margin-bottom: 28px !important;
    }

    .mp-account-size-card {
      padding: 18px 14px !important;
      transform: none !important;
    }

    .mp-account-detail-card {
      padding: 22px !important;
    }

    .mp-account-detail-layout {
      display: grid !important;
      grid-template-columns: 1fr !important;
      gap: 24px !important;
    }

    .mp-account-detail-main {
      min-width: 0 !important;
    }

    .mp-account-detail-main > div:nth-child(2) {
      font-size: clamp(34px, 12vw, 44px) !important;
      margin-bottom: 22px !important;
    }

    .mp-availability-pill {
      width: 100%;
      display: grid !important;
      grid-template-columns: 1fr;
      gap: 8px !important;
      padding: 12px 16px !important;
    }

    .mp-availability-pill > span:nth-child(2) {
      display: none;
    }

    .mp-timeline-content {
      padding: 22px !important;
    }

    .mp-timeline-content .mp-h3 {
      font-size: 19px !important;
    }

    .mp-faq-btn {
      font-size: 17px;
      padding: 20px 0;
    }

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
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 600;
    color: var(--mp-text-secondary);
  }

  .mp-stat-divider {
    width: 1px;
    height: 28px;
    background: var(--mp-border);
  }

  /* ══ LIVE PAYOUT TRACKER ══ */
  .mp-live-stats-section {
    padding-top: 72px;
    padding-bottom: 96px;
  }

  .mp-live-stats-shell,
  .mp-comparison-shell {
    position: relative;
    overflow: hidden;
    padding: 42px;
    border: 1px solid var(--mp-glass-border);
    border-top: 3px double var(--ink);
    background: var(--mp-glass-bg);
    backdrop-filter: var(--mp-glass-blur);
    -webkit-backdrop-filter: var(--mp-glass-blur);
  }

  .mp-live-stats-header,
  .mp-comparison-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 28px;
    margin-bottom: 32px;
  }

  .mp-live-stats-header .mp-h2,
  .mp-comparison-heading .mp-h2 {
    max-width: 780px;
  }

  .mp-live-stats-header .mp-p-lead,
  .mp-comparison-heading .mp-p-lead {
    max-width: 740px;
    margin-bottom: 0;
  }

  .mp-live-status {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    white-space: nowrap;
    padding: 8px 16px;
    border: 1px solid var(--mp-emerald);
    background: transparent;
    color: var(--mp-emerald-light);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-family: var(--font-mono);
  }

  .mp-live-status span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--mp-emerald);
  }

  .mp-live-stats-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
  }

  .mp-live-stat-card {
    min-height: 168px;
    padding: 24px;
    border: 1px solid var(--mp-border);
    background: var(--paper);
  }

  .mp-live-stat-card span,
  .mp-live-stat-card small {
    display: block;
    color: var(--mp-text-muted);
  }

  .mp-live-stat-card span {
    margin-bottom: 18px;
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-family: var(--font-mono);
  }

  .mp-live-stat-card strong {
    display: block;
    margin-bottom: 14px;
    color: var(--mp-text);
    font-family: var(--font-mono);
    font-size: clamp(28px, 3.6vw, 48px);
    line-height: 1;
    letter-spacing: -0.02em;
  }

  .mp-live-stat-card small {
    font-size: 13px;
    line-height: 1.5;
  }

  .mp-payout-tape {
    display: flex;
    gap: 12px;
    margin-top: 18px;
    overflow-x: auto;
    padding-bottom: 4px;
    scrollbar-width: thin;
  }

  .mp-payout-chip {
    flex: 0 0 auto;
    min-width: 250px;
    display: grid;
    gap: 6px;
    padding: 16px 18px;
    border: 1px solid var(--mp-border);
    background: var(--paper);
  }

  .mp-payout-chip strong {
    color: var(--mp-emerald-light);
    font-family: var(--font-mono);
    font-size: 20px;
  }

  .mp-payout-chip span {
    color: var(--mp-text);
    font-weight: 700;
  }

  .mp-payout-chip small {
    color: var(--mp-text-muted);
  }

  .mp-payout-chip.empty {
    min-width: 320px;
    border-color: var(--mp-border);
  }

  /* Comparison grid */
  .mp-comparison-section {
    padding-top: 96px;
    padding-bottom: 96px;
  }

  .mp-comparison-cta {
    flex: 0 0 auto;
    text-decoration: none;
  }

  .mp-comparison-table {
    display: grid;
    overflow: hidden;
    border: 1px solid var(--mp-border);
  }

  .mp-comparison-row {
    display: grid;
    grid-template-columns: 0.85fr 1.25fr 1.25fr;
    min-height: 82px;
    border-bottom: 1px solid var(--mp-border);
  }

  .mp-comparison-row:last-child {
    border-bottom: none;
  }

  .mp-comparison-row > div {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px 22px;
    color: var(--mp-text-secondary);
    line-height: 1.5;
    border-right: 1px solid var(--mp-border);
  }

  .mp-comparison-row > div:last-child {
    border-right: none;
  }

  .mp-comparison-row.header {
    min-height: 54px;
    background: var(--mp-glass-bg);
    border-bottom: 2px solid var(--ink);
  }

  .mp-comparison-row.header > div {
    color: var(--mp-text);
    font-size: 12px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-family: var(--font-mono);
  }

  .mp-comparison-row strong {
    color: var(--mp-text);
    font-weight: 800;
  }

  .mp-comparison-row .positive {
    color: var(--mp-text);
  }

  .mp-comparison-row .positive span,
  .mp-comparison-row .muted span {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    display: inline-grid;
    place-items: center;
    border-radius: 50%;
    font-weight: 900;
    border: 1px solid currentColor;
  }

  .mp-comparison-row .positive span {
    color: var(--mp-emerald);
  }

  .mp-comparison-row .muted span {
    color: var(--mp-red);
  }

  @media (max-width: 900px) {
    .mp-live-stats-header,
    .mp-comparison-heading {
      flex-direction: column;
    }

    .mp-live-stats-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .mp-comparison-row {
      grid-template-columns: 1fr;
    }

    .mp-comparison-row.header {
      display: none;
    }

    .mp-comparison-row > div {
      border-right: none;
      border-bottom: 1px solid var(--mp-border);
    }

    .mp-comparison-row > div:last-child {
      border-bottom: none;
    }
  }

  @media (max-width: 640px) {
    .mp-live-stats-shell,
    .mp-comparison-shell {
      padding: 22px;
    }

    .mp-live-stats-grid {
      grid-template-columns: 1fr;
    }

    .mp-live-stat-card {
      min-height: auto;
      padding: 20px;
    }

    .mp-payout-chip,
    .mp-payout-chip.empty {
      min-width: 86vw;
    }
  }

  @keyframes mp-scroll-bounce {
    0%, 100% { transform: translateY(0); opacity: 0.5; }
    50% { transform: translateY(8px); opacity: 1; }
  }
`;
