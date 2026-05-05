const fs = require("fs");
const path = require("path");
let docx;
try {
  docx = require("docx");
} catch (error) {
  docx = require(path.resolve(__dirname, "..", "backend", "node_modules", "docx"));
}

const {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip,
} = docx;

const OUTPUT_DIR = path.resolve(__dirname, "..", "docs", "generated");
const OUTPUT_PATH = path.join(
  OUTPUT_DIR,
  "PropFirm_Project_and_Financial_Projection_Report.docx",
);
const DATA_PATH = path.join(OUTPUT_DIR, "propfirm_projection_model.json");

const REPORT_DATE = new Date("2026-04-22T00:00:00+05:30");
const PROJECTION_START = new Date("2026-05-01T00:00:00+05:30");
const MONTHS = 36;
const START_CAPITAL = 5000;
const REINVEST_RATE = 0.8;
const RESERVE_RATE = 0.2;
const PHASE1_DRAWDOWN = 0.1;
const PHASE2_DRAWDOWN = 0.05;
const FUNDED_DRAWDOWN = 0.05;
const FUNDED_TRADER_SPLIT = 0.8;
const REAL_BROKER_LEVERAGE = 300;
const DEMO_LEVERAGE = 30;
const REAL_BROKER_LEVERAGE_LABEL = "1:300";
const DEMO_LEVERAGE_LABEL = "1:30";
const TOTAL_INSTRUMENTS = 32;
const FOREX_PAIRS = 28;
const COMMODITY_COUNT = 2;
const INDEX_COUNT = 2;
const BACKEND_ROUTE_COUNT = 17;
const BACKEND_SERVICE_COUNT = 4;
const FRONTEND_PAGE_COUNT = 16;
const FRONTEND_COMPONENT_COUNT = 9;
const REPORT_AUTHOR = "OpenAI Codex";
const REPORT_TITLE = "PropFirm Platform Project and Financial Projection Report";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2mQ0YAAAAASUVORK5CYII=",
  "base64",
);

const SAAS_PLANS = [
  { code: "starter", name: "Starter", price: 199, traderLimit: 100 },
  { code: "growth", name: "Growth", price: 499, traderLimit: 500 },
  { code: "enterprise", name: "Enterprise", price: 999, traderLimit: null },
];

const STAGES = [
  { label: "25 x $1k", accounts: 25, accountSize: 1000 },
  { label: "30 x $1k", accounts: 30, accountSize: 1000 },
  { label: "40 x $1k", accounts: 40, accountSize: 1000 },
  { label: "50 x $1k", accounts: 50, accountSize: 1000 },
  { label: "75 x $1k", accounts: 75, accountSize: 1000 },
  { label: "100 x $1k", accounts: 100, accountSize: 1000 },
  { label: "100 x $2k", accounts: 100, accountSize: 2000 },
  { label: "150 x $2k", accounts: 150, accountSize: 2000 },
  { label: "200 x $2k", accounts: 200, accountSize: 2000 },
  { label: "100 x $5k", accounts: 100, accountSize: 5000 },
  { label: "150 x $5k", accounts: 150, accountSize: 5000 },
  { label: "200 x $5k", accounts: 200, accountSize: 5000 },
].map((stage) => ({
  ...stage,
  requiredDeployable: stage.accounts * stage.accountSize * PHASE1_DRAWDOWN,
}));

const SCENARIO_CONFIGS = {
  conservative: {
    name: "Conservative",
    color: "#a16207",
    description:
      "Assumes slower trader capture, lower evaluation edge, slower tenant acquisition, and higher relative operating friction.",
    p1PassRate: 0.09,
    p1FailRate: 0.68,
    p1ExpiredRate: 0.23,
    p2PassRate: 0.22,
    p2FailRate: 0.55,
    p2ExpiredRate: 0.23,
    p1FailedLossPct: 0.038,
    p1ExpiredLossPct: 0.005,
    p1PassedGainPct: 0.1,
    p2FailedLossPct: 0.028,
    p2ExpiredLossPct: 0.003,
    p2PassedGainPct: 0.05,
    fundedFirmNetPct: 0.0015,
    fundedAttritionRate: 0.1,
    fixedCost: 950,
    fixedCostGrowth: 0.007,
    perBatchAccountCost: 2.5,
    perTenantCost: 50,
    perFundedAccountCost: 4,
    contingencyPct: 0.05,
    tenantChurnRate: 0.03,
    revenueShareStartMonth: 12,
    revenueShareBasePerTenant: 20,
    revenueShareGrowthPerMonth: 1.2,
    planMixStart: { starter: 0.9, growth: 0.1, enterprise: 0 },
    planMixEnd: { starter: 0.75, growth: 0.2, enterprise: 0.05 },
    tenantAdds: (month) => {
      if (month < 7) return 0;
      if (month <= 18) return month % 3 === 1 ? 1 : 0;
      return month % 2 === 1 ? 1 : 0;
    },
  },
  base: {
    name: "Base",
    color: "#1d4ed8",
    description:
      "Assumes steady monthly tenant acquisition, a stable evaluation-stage edge, modest funded-account monetization, and disciplined cost control.",
    p1PassRate: 0.12,
    p1FailRate: 0.7,
    p1ExpiredRate: 0.18,
    p2PassRate: 0.3,
    p2FailRate: 0.5,
    p2ExpiredRate: 0.2,
    p1FailedLossPct: 0.045,
    p1ExpiredLossPct: 0.006,
    p1PassedGainPct: 0.1,
    p2FailedLossPct: 0.032,
    p2ExpiredLossPct: 0.004,
    p2PassedGainPct: 0.05,
    fundedFirmNetPct: 0.0025,
    fundedAttritionRate: 0.07,
    fixedCost: 850,
    fixedCostGrowth: 0.006,
    perBatchAccountCost: 2.2,
    perTenantCost: 45,
    perFundedAccountCost: 4.5,
    contingencyPct: 0.045,
    tenantChurnRate: 0.02,
    revenueShareStartMonth: 8,
    revenueShareBasePerTenant: 35,
    revenueShareGrowthPerMonth: 1.5,
    planMixStart: { starter: 0.9, growth: 0.1, enterprise: 0 },
    planMixEnd: { starter: 0.6, growth: 0.28, enterprise: 0.12 },
    tenantAdds: (month) => {
      if (month < 5) return 0;
      if (month <= 24) return 1;
      return 2;
    },
  },
  aggressive: {
    name: "Aggressive",
    color: "#047857",
    description:
      "Assumes a stronger trader acquisition engine, better conversion to funded traders, faster white-label uptake, and earlier plan upgrades.",
    p1PassRate: 0.14,
    p1FailRate: 0.72,
    p1ExpiredRate: 0.14,
    p2PassRate: 0.35,
    p2FailRate: 0.48,
    p2ExpiredRate: 0.17,
    p1FailedLossPct: 0.052,
    p1ExpiredLossPct: 0.008,
    p1PassedGainPct: 0.1,
    p2FailedLossPct: 0.035,
    p2ExpiredLossPct: 0.004,
    p2PassedGainPct: 0.05,
    fundedFirmNetPct: 0.0035,
    fundedAttritionRate: 0.05,
    fixedCost: 900,
    fixedCostGrowth: 0.007,
    perBatchAccountCost: 2.4,
    perTenantCost: 55,
    perFundedAccountCost: 5.5,
    contingencyPct: 0.05,
    tenantChurnRate: 0.015,
    revenueShareStartMonth: 7,
    revenueShareBasePerTenant: 55,
    revenueShareGrowthPerMonth: 2.5,
    planMixStart: { starter: 0.85, growth: 0.15, enterprise: 0 },
    planMixEnd: { starter: 0.5, growth: 0.3, enterprise: 0.2 },
    tenantAdds: (month) => {
      if (month < 4) return 0;
      if (month <= 12) return 1;
      if (month <= 24) return 2;
      return 3;
    },
  },
};

function round(value, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function interpolateMix(startMix, endMix, t) {
  const raw = {
    starter: lerp(startMix.starter, endMix.starter, t),
    growth: lerp(startMix.growth, endMix.growth, t),
    enterprise: lerp(startMix.enterprise, endMix.enterprise, t),
  };
  const total = raw.starter + raw.growth + raw.enterprise;
  return {
    starter: raw.starter / total,
    growth: raw.growth / total,
    enterprise: raw.enterprise / total,
  };
}

function weightedArpu(mix) {
  return round(
    mix.starter * SAAS_PLANS[0].price +
      mix.growth * SAAS_PLANS[1].price +
      mix.enterprise * SAAS_PLANS[2].price,
  );
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function formatCurrencyPrecise(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value) || 0);
}

function formatPct(value, digits = 1) {
  return `${formatNumber((Number(value) || 0) * 100, digits)}%`;
}

function formatMonth(index) {
  const date = new Date(PROJECTION_START);
  date.setMonth(PROJECTION_START.getMonth() + index);
  return date.toLocaleString("en-US", { month: "short", year: "numeric" });
}

function formatDate(date) {
  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function getStageForCapital(deployableCapital) {
  let current = STAGES[0];
  for (const stage of STAGES) {
    if (deployableCapital >= stage.requiredDeployable) {
      current = stage;
    }
  }
  return current;
}

function simulateScenario(key, config) {
  let deployableCapital = START_CAPITAL;
  let reserveCapital = 0;
  let activeTenants = 0;
  let activeFundedAccounts = 0;
  let activeFundedNotional = 0;
  const rows = [];

  for (let month = 1; month <= MONTHS; month += 1) {
    const openingDeployable = deployableCapital;
    const openingReserve = reserveCapital;
    const stage = getStageForCapital(openingDeployable);
    const batchAccounts = stage.accounts;
    const accountSize = stage.accountSize;
    const virtualNotional = batchAccounts * accountSize;
    const drawdownCapitalRequired = virtualNotional * PHASE1_DRAWDOWN;
    const estimatedMarginAtBroker = virtualNotional / REAL_BROKER_LEVERAGE;

    const phase1Passers = batchAccounts * config.p1PassRate;
    const phase1Failers = batchAccounts * config.p1FailRate;
    const phase1Expired = batchAccounts * config.p1ExpiredRate;

    const phase2Candidates = phase1Passers;
    const phase2Passers = phase2Candidates * config.p2PassRate;
    const phase2Failers = phase2Candidates * config.p2FailRate;
    const phase2Expired = phase2Candidates * config.p2ExpiredRate;

    const phase1Revenue =
      phase1Failers * accountSize * config.p1FailedLossPct +
      phase1Expired * accountSize * config.p1ExpiredLossPct -
      phase1Passers * accountSize * config.p1PassedGainPct;

    const phase2Revenue =
      phase2Failers * accountSize * config.p2FailedLossPct +
      phase2Expired * accountSize * config.p2ExpiredLossPct -
      phase2Passers * accountSize * config.p2PassedGainPct;

    const evaluationRevenue = phase1Revenue + phase2Revenue;

    const newFundedAccounts = phase2Passers;
    const newFundedNotional = newFundedAccounts * accountSize;

    activeFundedAccounts =
      activeFundedAccounts * (1 - config.fundedAttritionRate) + newFundedAccounts;
    activeFundedNotional =
      activeFundedNotional * (1 - config.fundedAttritionRate) + newFundedNotional;

    const fundedRevenue = activeFundedNotional * config.fundedFirmNetPct;

    const addedTenants = config.tenantAdds(month);
    activeTenants = activeTenants * (1 - config.tenantChurnRate) + addedTenants;

    const t = clamp((month - 1) / (MONTHS - 1), 0, 1);
    const planMix = interpolateMix(config.planMixStart, config.planMixEnd, t);
    const blendedArpu = weightedArpu(planMix);
    const saasRevenue = activeTenants * blendedArpu;

    const revenueSharePerTenant =
      month >= config.revenueShareStartMonth
        ? config.revenueShareBasePerTenant +
          config.revenueShareGrowthPerMonth * (month - config.revenueShareStartMonth)
        : 0;
    const revenueShareRevenue = activeTenants * revenueSharePerTenant;

    const totalRevenue =
      evaluationRevenue + fundedRevenue + saasRevenue + revenueShareRevenue;

    const fixedCost =
      config.fixedCost * Math.pow(1 + config.fixedCostGrowth, month - 1);
    const variableCost =
      batchAccounts * config.perBatchAccountCost +
      activeTenants * config.perTenantCost +
      activeFundedAccounts * config.perFundedAccountCost;
    const contingencyCost = totalRevenue * config.contingencyPct;
    const totalCost = fixedCost + variableCost + contingencyCost;
    const netProfit = totalRevenue - totalCost;

    let reinvestedCapital = 0;
    let retainedReserve = 0;
    let reserveDraw = 0;
    let deployableDraw = 0;

    if (netProfit >= 0) {
      reinvestedCapital = netProfit * REINVEST_RATE;
      retainedReserve = netProfit * RESERVE_RATE;
      deployableCapital += reinvestedCapital;
      reserveCapital += retainedReserve;
    } else {
      const lossAbs = Math.abs(netProfit);
      reserveDraw = Math.min(reserveCapital, lossAbs);
      deployableDraw = Math.max(0, lossAbs - reserveDraw);
      reserveCapital = Math.max(0, reserveCapital - reserveDraw);
      deployableCapital = Math.max(0, deployableCapital - deployableDraw);
    }

    const endingEquity = deployableCapital + reserveCapital;

    rows.push({
      scenarioKey: key,
      scenarioName: config.name,
      month,
      monthLabel: formatMonth(month - 1),
      stageLabel: stage.label,
      batchAccounts: round(batchAccounts, 2),
      accountSize: round(accountSize, 2),
      virtualNotional: round(virtualNotional, 2),
      drawdownCapitalRequired: round(drawdownCapitalRequired, 2),
      estimatedMarginAtBroker: round(estimatedMarginAtBroker, 2),
      openingDeployable: round(openingDeployable, 2),
      openingReserve: round(openingReserve, 2),
      phase1Passers: round(phase1Passers, 2),
      phase1Failers: round(phase1Failers, 2),
      phase1Expired: round(phase1Expired, 2),
      phase2Passers: round(phase2Passers, 2),
      phase2Failers: round(phase2Failers, 2),
      phase2Expired: round(phase2Expired, 2),
      newFundedAccounts: round(newFundedAccounts, 2),
      activeFundedAccounts: round(activeFundedAccounts, 2),
      activeFundedNotional: round(activeFundedNotional, 2),
      activeTenants: round(activeTenants, 2),
      blendedArpu: round(blendedArpu, 2),
      revenueSharePerTenant: round(revenueSharePerTenant, 2),
      evaluationRevenue: round(evaluationRevenue, 2),
      fundedRevenue: round(fundedRevenue, 2),
      saasRevenue: round(saasRevenue, 2),
      revenueShareRevenue: round(revenueShareRevenue, 2),
      totalRevenue: round(totalRevenue, 2),
      fixedCost: round(fixedCost, 2),
      variableCost: round(variableCost, 2),
      contingencyCost: round(contingencyCost, 2),
      totalCost: round(totalCost, 2),
      netProfit: round(netProfit, 2),
      reinvestedCapital: round(reinvestedCapital, 2),
      retainedReserve: round(retainedReserve, 2),
      reserveDraw: round(reserveDraw, 2),
      deployableDraw: round(deployableDraw, 2),
      closingDeployable: round(deployableCapital, 2),
      closingReserve: round(reserveCapital, 2),
      endingEquity: round(endingEquity, 2),
    });
  }

  const month12 = rows[11];
  const month24 = rows[23];
  const month36 = rows[35];

  const totals = rows.reduce(
    (acc, row) => {
      acc.evaluationRevenue += row.evaluationRevenue;
      acc.fundedRevenue += row.fundedRevenue;
      acc.saasRevenue += row.saasRevenue;
      acc.revenueShareRevenue += row.revenueShareRevenue;
      acc.totalRevenue += row.totalRevenue;
      acc.totalCost += row.totalCost;
      acc.netProfit += row.netProfit;
      return acc;
    },
    {
      evaluationRevenue: 0,
      fundedRevenue: 0,
      saasRevenue: 0,
      revenueShareRevenue: 0,
      totalRevenue: 0,
      totalCost: 0,
      netProfit: 0,
    },
  );

  return {
    key,
    name: config.name,
    description: config.description,
    color: config.color,
    assumptions: config,
    rows,
    totals: Object.fromEntries(
      Object.entries(totals).map(([metric, value]) => [metric, round(value, 2)]),
    ),
    checkpoints: { month12, month24, month36 },
  };
}

function paragraph(text, options = {}) {
  return new Paragraph({
    spacing: { after: 180, line: 300 },
    ...options,
    children: [
      new TextRun({
        text,
        ...options.run,
      }),
    ],
  });
}

function richParagraph(parts, options = {}) {
  return new Paragraph({
    spacing: { after: 180, line: 300 },
    ...options,
    children: parts.map((part) =>
      new TextRun({
        text: part.text,
        bold: part.bold,
        italics: part.italics,
        underline: part.underline,
        color: part.color,
        size: part.size,
      }),
    ),
  });
}

function heading(text, level, options = {}) {
  return new Paragraph({
    text,
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 240 : 160, after: 120 },
    ...options,
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    text,
    bullet: { level },
    spacing: { after: 120, line: 280 },
  });
}

function addPageBreak(children) {
  children.push(
    new Paragraph({
      children: [new PageBreak()],
    }),
  );
}

function tableTextCell(text, options = {}) {
  return new TableCell({
    width: options.width ? { size: options.width, type: WidthType.DXA } : undefined,
    shading: options.fill ? { fill: options.fill } : undefined,
    margins: {
      top: 90,
      bottom: 90,
      left: 90,
      right: 90,
    },
    children: [
      new Paragraph({
        spacing: { after: 0 },
        alignment: options.alignment || AlignmentType.LEFT,
        children: [
          new TextRun({
            text,
            bold: !!options.bold,
            color: options.color,
            size: options.size || 20,
          }),
        ],
      }),
    ],
  });
}

function createTable(headers, rows, options = {}) {
  const borderColor = options.borderColor || "CFCFCF";
  const columnWidths = options.columnWidths || [];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.SINGLE, color: borderColor, size: 1 },
      bottom: { style: BorderStyle.SINGLE, color: borderColor, size: 1 },
      left: { style: BorderStyle.SINGLE, color: borderColor, size: 1 },
      right: { style: BorderStyle.SINGLE, color: borderColor, size: 1 },
      insideHorizontal: { style: BorderStyle.SINGLE, color: borderColor, size: 1 },
      insideVertical: { style: BorderStyle.SINGLE, color: borderColor, size: 1 },
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((header, index) =>
          tableTextCell(header, {
            bold: true,
            fill: options.headerFill || "E9EEF9",
            color: options.headerColor || "1F2937",
            alignment: AlignmentType.CENTER,
            width: columnWidths[index],
            size: options.headerSize || 19,
          }),
        ),
      }),
      ...rows.map((row, rowIndex) =>
        new TableRow({
          children: row.map((cell, index) =>
            tableTextCell(String(cell), {
              fill:
                rowIndex % 2 === 0
                  ? options.rowFill || "FFFFFF"
                  : options.altRowFill || "F8FAFC",
              width: columnWidths[index],
              size: options.bodySize || 18,
            }),
          ),
        }),
      ),
    ],
  });
}

function makeSvgLineChart({ title, series, width = 720, height = 340, currency = false }) {
  const margin = { top: 30, right: 25, bottom: 45, left: 60 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = series.flatMap((item) => item.values);
  const maxValue = Math.max(...values, 1);
  const xStep = plotWidth / (MONTHS - 1);

  const gridLines = 5;
  let svg = `<?xml version="1.0" encoding="UTF-8"?>`;
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect width="100%" height="100%" fill="#ffffff"/>`;
  svg += `<text x="${width / 2}" y="18" font-size="15" text-anchor="middle" fill="#111827" font-family="Arial">${title}</text>`;

  for (let i = 0; i <= gridLines; i += 1) {
    const y = margin.top + (plotHeight / gridLines) * i;
    const labelValue = maxValue - (maxValue / gridLines) * i;
    svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#E5E7EB" stroke-width="1"/>`;
    const label = currency ? `$${Math.round(labelValue / 1000)}k` : `${Math.round(labelValue)}`;
    svg += `<text x="${margin.left - 8}" y="${y + 4}" font-size="10" text-anchor="end" fill="#6B7280" font-family="Arial">${label}</text>`;
  }

  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#94A3B8" stroke-width="1.2"/>`;
  svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#94A3B8" stroke-width="1.2"/>`;

  const xLabels = [0, 5, 11, 17, 23, 29, 35];
  for (const index of xLabels) {
    const x = margin.left + xStep * index;
    svg += `<text x="${x}" y="${height - margin.bottom + 18}" font-size="10" text-anchor="middle" fill="#6B7280" font-family="Arial">${index + 1}</text>`;
  }

  series.forEach((item, itemIndex) => {
    const path = item.values
      .map((value, index) => {
        const x = margin.left + index * xStep;
        const y = margin.top + plotHeight - (value / maxValue) * plotHeight;
        return `${index === 0 ? "M" : "L"} ${round(x, 2)} ${round(y, 2)}`;
      })
      .join(" ");
    svg += `<path d="${path}" fill="none" stroke="${item.color}" stroke-width="2.5"/>`;
    svg += `<text x="${margin.left + itemIndex * 150}" y="${height - 8}" font-size="11" fill="${item.color}" font-family="Arial">${item.label}</text>`;
  });

  svg += `</svg>`;
  return svg;
}

function makeSvgBarChart({ title, labels, values, color, width = 720, height = 340 }) {
  const margin = { top: 30, right: 30, bottom: 45, left: 60 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(...values, 1);
  const barWidth = plotWidth / labels.length / 1.8;
  let svg = `<?xml version="1.0" encoding="UTF-8"?>`;
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect width="100%" height="100%" fill="#ffffff"/>`;
  svg += `<text x="${width / 2}" y="18" font-size="15" text-anchor="middle" fill="#111827" font-family="Arial">${title}</text>`;

  for (let i = 0; i <= 5; i += 1) {
    const y = margin.top + (plotHeight / 5) * i;
    const labelValue = maxValue - (maxValue / 5) * i;
    svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#E5E7EB" stroke-width="1"/>`;
    svg += `<text x="${margin.left - 8}" y="${y + 4}" font-size="10" text-anchor="end" fill="#6B7280" font-family="Arial">$${Math.round(labelValue / 1000)}k</text>`;
  }

  labels.forEach((label, index) => {
    const x = margin.left + (plotWidth / labels.length) * index + 25;
    const value = values[index];
    const barHeight = (value / maxValue) * plotHeight;
    const y = margin.top + plotHeight - barHeight;
    svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${color[index] || "#2563EB"}" rx="4"/>`;
    svg += `<text x="${x + barWidth / 2}" y="${height - 18}" font-size="11" text-anchor="middle" fill="#374151" font-family="Arial">${label}</text>`;
    svg += `<text x="${x + barWidth / 2}" y="${y - 6}" font-size="10" text-anchor="middle" fill="#111827" font-family="Arial">$${Math.round(value / 1000)}k</text>`;
  });

  svg += `</svg>`;
  return svg;
}

function chartParagraph(svg, width = 620, height = 290) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
    children: [
      new ImageRun({
        type: "svg",
        data: Buffer.from(svg),
        fallback: {
          type: "png",
          data: TRANSPARENT_PNG,
        },
        transformation: { width, height },
      }),
    ],
  });
}

function buildScenarioComparisonTable(scenarios) {
  return createTable(
    [
      "Scenario",
      "Month 12 Equity",
      "Month 24 Equity",
      "Month 36 Equity",
      "Month 36 Revenue",
      "Month 36 Active Tenants",
      "Month 36 Active Funded",
    ],
    scenarios.map((scenario) => [
      scenario.name,
      formatCurrency(scenario.checkpoints.month12.endingEquity),
      formatCurrency(scenario.checkpoints.month24.endingEquity),
      formatCurrency(scenario.checkpoints.month36.endingEquity),
      formatCurrency(scenario.checkpoints.month36.totalRevenue),
      formatNumber(scenario.checkpoints.month36.activeTenants, 1),
      formatNumber(scenario.checkpoints.month36.activeFundedAccounts, 1),
    ]),
    {
      columnWidths: [1200, 1400, 1400, 1400, 1400, 1300, 1300],
    },
  );
}

function buildScenarioAssumptionsTable(scenario) {
  const a = scenario.assumptions;
  return createTable(
    ["Assumption", "Value"],
    [
      ["Phase 1 pass / fail / expire", `${formatPct(a.p1PassRate)} / ${formatPct(a.p1FailRate)} / ${formatPct(a.p1ExpiredRate)}`],
      ["Phase 2 pass / fail / expire", `${formatPct(a.p2PassRate)} / ${formatPct(a.p2FailRate)} / ${formatPct(a.p2ExpiredRate)}`],
      ["Phase 1 average failed-account trader loss", formatPct(a.p1FailedLossPct)],
      ["Phase 2 average failed-account trader loss", formatPct(a.p2FailedLossPct)],
      ["Funded firm net return on active funded notional", formatPct(a.fundedFirmNetPct)],
      ["Monthly funded attrition", formatPct(a.fundedAttritionRate)],
      ["Fixed monthly cost at month 1", formatCurrency(a.fixedCost)],
      ["Monthly fixed-cost inflation", formatPct(a.fixedCostGrowth)],
      ["Tenant churn", formatPct(a.tenantChurnRate)],
      ["Revenue share activation month", String(a.revenueShareStartMonth)],
    ],
    { columnWidths: [3600, 2200] },
  );
}

function buildProjectionTable(rows) {
  return createTable(
    [
      "Month",
      "Batch",
      "Deployable Start",
      "Reserve Start",
      "Eval Rev",
      "Funded Rev",
      "SaaS Rev",
      "Rev Share",
      "Net Profit",
      "Ending Equity",
    ],
    rows.map((row) => [
      row.monthLabel,
      row.stageLabel,
      formatCurrency(row.openingDeployable),
      formatCurrency(row.openingReserve),
      formatCurrency(row.evaluationRevenue),
      formatCurrency(row.fundedRevenue),
      formatCurrency(row.saasRevenue),
      formatCurrency(row.revenueShareRevenue),
      formatCurrency(row.netProfit),
      formatCurrency(row.endingEquity),
    ]),
    {
      columnWidths: [900, 1050, 1100, 1000, 900, 900, 950, 950, 950, 1000],
      bodySize: 15,
      headerSize: 16,
    },
  );
}

function buildOperationsTable(rows) {
  return createTable(
    [
      "Month",
      "Virtual Notional",
      "Risk Capital",
      "New Funded",
      "Active Funded",
      "Active Tenants",
      "Blended ARPU",
      "Broker Margin Est.",
    ],
    rows.map((row) => [
      row.monthLabel,
      formatCurrency(row.virtualNotional),
      formatCurrency(row.drawdownCapitalRequired),
      formatNumber(row.newFundedAccounts, 1),
      formatNumber(row.activeFundedAccounts, 1),
      formatNumber(row.activeTenants, 1),
      formatCurrency(row.blendedArpu),
      formatCurrency(row.estimatedMarginAtBroker),
    ]),
    {
      columnWidths: [950, 1100, 1000, 900, 900, 900, 1000, 1000],
      bodySize: 15,
      headerSize: 16,
    },
  );
}

function projectionHighlights(scenario) {
  const month12 = scenario.checkpoints.month12;
  const month24 = scenario.checkpoints.month24;
  const month36 = scenario.checkpoints.month36;
  return [
    `By ${month12.monthLabel}, the ${scenario.name.toLowerCase()} scenario reaches ${formatCurrency(month12.endingEquity)} of total equity, supports a ${month12.stageLabel} batch, and carries ${formatNumber(month12.activeTenants, 1)} expected paying tenants.`,
    `By ${month24.monthLabel}, the same scenario reaches ${formatCurrency(month24.endingEquity)} of equity, grows the SaaS engine to ${formatNumber(month24.activeTenants, 1)} expected tenants, and carries ${formatNumber(month24.activeFundedAccounts, 1)} active funded traders on the A-book side.`,
    `By ${month36.monthLabel}, total monthly revenue rises to ${formatCurrency(month36.totalRevenue)} and ending equity reaches ${formatCurrency(month36.endingEquity)} under the ${scenario.name.toLowerCase()} case.`,
  ];
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const scenarios = [
    simulateScenario("conservative", SCENARIO_CONFIGS.conservative),
    simulateScenario("base", SCENARIO_CONFIGS.base),
    simulateScenario("aggressive", SCENARIO_CONFIGS.aggressive),
  ];

  const baseScenario = scenarios.find((scenario) => scenario.key === "base");
  const scenarioMonth36Bar = makeSvgBarChart({
    title: "Month 36 Ending Equity by Scenario",
    labels: scenarios.map((scenario) => scenario.name),
    values: scenarios.map((scenario) => scenario.checkpoints.month36.endingEquity),
    color: scenarios.map((scenario) => scenario.color),
  });

  const equityGrowthChart = makeSvgLineChart({
    title: "Ending Equity Growth Over 36 Months",
    currency: true,
    series: scenarios.map((scenario) => ({
      label: scenario.name,
      color: scenario.color,
      values: scenario.rows.map((row) => row.endingEquity),
    })),
  });

  const baseRevenueMixChart = makeSvgLineChart({
    title: "Base Scenario Monthly Revenue Mix",
    currency: true,
    series: [
      {
        label: "Evaluation B-book Revenue",
        color: "#0F766E",
        values: baseScenario.rows.map((row) => row.evaluationRevenue),
      },
      {
        label: "SaaS Subscription Revenue",
        color: "#1D4ED8",
        values: baseScenario.rows.map((row) => row.saasRevenue),
      },
      {
        label: "Revenue Share Revenue",
        color: "#9333EA",
        values: baseScenario.rows.map((row) => row.revenueShareRevenue),
      },
      {
        label: "Funded A-book Firm Share",
        color: "#B45309",
        values: baseScenario.rows.map((row) => row.fundedRevenue),
      },
    ],
  });

  const baseCapacityChart = makeSvgLineChart({
    title: "Base Scenario Virtual Capacity and Funded Notional",
    currency: true,
    series: [
      {
        label: "Virtual Batch Notional",
        color: "#2563EB",
        values: baseScenario.rows.map((row) => row.virtualNotional),
      },
      {
        label: "Active Funded Notional",
        color: "#059669",
        values: baseScenario.rows.map((row) => row.activeFundedNotional),
      },
      {
        label: "Deployable Capital",
        color: "#DC2626",
        values: baseScenario.rows.map((row) => row.closingDeployable),
      },
    ],
  });

  const children = [];

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 600, after: 220 },
      children: [new TextRun({ text: REPORT_TITLE, bold: true, size: 34 })],
    }),
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 140 },
      children: [
        new TextRun({
          text: "Project analysis, architecture review, and 36-month financial projection",
          size: 24,
          color: "334155",
        }),
      ],
    }),
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [
        new TextRun({
          text: `Prepared from repo review and modeled assumptions on ${formatDate(REPORT_DATE)}`,
          size: 20,
          color: "475569",
        }),
      ],
    }),
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: "Confidential founder working paper",
          size: 20,
          italics: true,
          color: "64748B",
        }),
      ],
    }),
  );
  children.push(
    createTable(
      ["Locked Model Inputs", "Confirmed Value"],
      [
        ["Starting capital", formatCurrency(START_CAPITAL)],
        ["Batch cadence", "One new batch every month"],
        ["Reinvestment / reserve split", "80% reinvested / 20% retained"],
        ["Starting structure", "50 virtual accounts x $1,000"],
        ["Evaluation execution model", "Phase 1 and Phase 2 are reverse-traded B-book on a real broker"],
        ["Funded execution model", "Funded accounts are A-booked 1:1 with real money"],
        ["Funded trader split", `${formatPct(FUNDED_TRADER_SPLIT)} to trader / ${formatPct(1 - FUNDED_TRADER_SPLIT)} to firm`],
        ["Leverage assumptions", `Real broker ${REAL_BROKER_LEVERAGE_LABEL}; demo accounts ${DEMO_LEVERAGE_LABEL}`],
        ["Revenue model", "Own-firm trading economics + SaaS subscriptions + optional tenant revenue share"],
        ["Projection horizon", `${MONTHS} months (${formatMonth(0)} to ${formatMonth(MONTHS - 1)})`],
      ],
      { columnWidths: [3600, 3200] },
    ),
  );

  addPageBreak(children);

  children.push(heading("Table of Contents", HeadingLevel.HEADING_1));
  children.push(
    new TableOfContents("Contents", {
      hyperlink: true,
      headingStyleRange: "1-3",
    }),
  );

  addPageBreak(children);

  children.push(heading("Executive Summary", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "This report evaluates the current PropFirm repository as both a trading product and a white-label SaaS platform. The repo already contains a serious operating core: a React 19 frontend, an Express 5 backend, PostgreSQL persistence, Socket.IO realtime delivery, Redis support, tenant branding and billing scaffolding, a challenge engine, payout flows, KYC review, and a large admin surface. From a product standpoint the platform is already more than a landing page plus dashboard. It is a full operating stack for a simulated-prop business that can also be sold to other firms as infrastructure.",
    ),
  );
  children.push(
    paragraph(
      "Your commercial model is unusual in a good way because it blends two businesses. The first is your own firm, where traders join for free, phase 1 and phase 2 performance is reverse-traded on a real broker, and funded traders are A-booked 1:1 on live money. The second is the software business, where other prop firms pay monthly subscription fees to launch white-label firms on top of your infrastructure. That means the platform can monetize its own trading edge while also creating recurring SaaS revenue that is not directly tied to your own trading results.",
    ),
  );
  children.push(
    paragraph(
      `The projection model in this report starts from ${formatCurrency(START_CAPITAL)} of deployable capital, assumes one new batch every month, and applies the rule that 80% of monthly net profit is reinvested into the next stage while 20% is retained as reserve. The starting batch is 50 virtual $1,000 accounts. Because phase 1 risk is modeled against drawdown capital rather than full displayed notional, that opening batch maps cleanly to your capital logic: 50 x $1,000 at a 10% phase 1 drawdown equals ${formatCurrency(5000)} of risk capital, which matches the starting deployable pool.`,
    ),
  );
  children.push(
    paragraph(
      `In the base scenario, the model reaches ${formatCurrency(baseScenario.checkpoints.month36.endingEquity)} of total equity by ${baseScenario.checkpoints.month36.monthLabel}, produces ${formatCurrency(baseScenario.checkpoints.month36.totalRevenue)} of monthly revenue by month 36, supports a ${baseScenario.checkpoints.month36.stageLabel} operating batch, and grows to ${formatNumber(baseScenario.checkpoints.month36.activeTenants, 1)} expected paying SaaS tenants. The aggressive case expands materially faster, while the conservative case remains viable but grows more slowly and stays more dependent on discipline in cost control and tenant acquisition.`,
    ),
  );
  children.push(
    paragraph(
      "The most important strategic conclusion is that your own trading model and your SaaS model support each other. The evaluation-stage reverse-trade edge helps finance the early period before SaaS scale is meaningful. Once recurring SaaS MRR grows, it becomes a stabilizer that can support technology, support, compliance, and broker costs even during weaker trading periods. That is a strong structure if you keep risk management tight, maintain a clean funded-book process, and continue hardening the multi-tenant product for outside firms.",
    ),
  );
  children.push(buildScenarioComparisonTable(scenarios));
  children.push(chartParagraph(equityGrowthChart));

  children.push(heading("Project Overview", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "Repo-confirmed documentation shows a serious multi-module product rather than a prototype. The platform covers the full trader lifecycle: landing page, onboarding, registration, authentication, KYC, challenge creation, live trading, account monitoring, automated progression, payout requests, disputes, chat, and admin review. The codebase also contains multi-tenant branding, tenant-aware settings, billing routes, and tenant management views, which means the platform is already positioned as software infrastructure rather than a single-brand application.",
    ),
  );
  children.push(
    createTable(
      ["Repo Snapshot", "Observed in Current Codebase"],
      [
        ["Backend stack", "Node.js, Express 5, PostgreSQL, Socket.IO, Redis-ready token cache, JWT auth"],
        ["Frontend stack", "React 19, React Router 7, Axios, Lightweight Charts, Recharts"],
        ["Trading/risk engines", "challengeEngine.js, priceFeed.js, progressionService.js, violation engine"],
        ["Backend route modules", `${BACKEND_ROUTE_COUNT}`],
        ["Backend service modules", `${BACKEND_SERVICE_COUNT}`],
        ["Frontend page modules", `${FRONTEND_PAGE_COUNT}`],
        ["Shared component modules", `${FRONTEND_COMPONENT_COUNT}`],
        ["Instrument coverage", `${FOREX_PAIRS} forex pairs, ${COMMODITY_COUNT} metals, ${INDEX_COUNT} indices (${TOTAL_INSTRUMENTS} total symbols)`],
        ["Multi-tenant signals", "Branding context, tenant routing utilities, tenant settings, tenant billing, tenant admin surface"],
      ],
      { columnWidths: [2200, 4600] },
    ),
  );
  children.push(
    paragraph(
      "The technical documentation also confirms several things that matter commercially. The admin stack is broad enough to operate a real prop program, not just market one. The platform has explicit account state transitions, automated drawdown enforcement, payout review, support workflows, and a live exposure table for B-book monitoring. Those elements are exactly what make the software saleable to other firms later, because they reduce the amount of manual operational tooling a tenant would otherwise need to build from scratch.",
    ),
  );
  children.push(
    paragraph(
      "There are still engineering gaps and hardening opportunities. The documentation highlights monolithic tendencies in server.js, mixed schema ownership between migrations and runtime DDL, incomplete end-to-end coverage, and the continuing need to tighten multi-tenant control planes. None of those issues make the platform unusable. They simply mean the current codebase should be treated as a strong operating product in active maturation, not as a finished enterprise platform.",
    ),
  );

  children.push(heading("Current Platform Status", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "From a readiness perspective, the platform already has the bones required for commercial use. Traders can sign up, authenticate, manage accounts, open and close trades, and follow live account metrics. Admins can review accounts, manage payouts, review KYC, monitor violations, and handle tenant setup. The documentation and code also show white-label support is no longer just conceptual. There is tenant branding, tenant routing, tenant billing, tenant-specific settings, and a tenant admin panel. This is important because it means the SaaS side of the business does not start from zero.",
    ),
  );
  children.push(
    paragraph(
      "The strongest product assets today are the challenge engine, the risk-enforcement logic, the broad admin workspace, and the multi-tenant foundation. Those are the parts of a prop stack that are hardest to fake and most painful to rebuild. A polished landing page can be redone in weeks; a working challenge engine, payout workflow, and tenant-aware admin surface are much more valuable. That is why the platform should be seen as a leverageable operating asset, not just as code.",
    ),
  );
  children.push(
    bullet("Automated challenge progression is already part of the codebase, including pass, fail, expiry, and funded transitions."),
  );
  children.push(
    bullet("Realtime delivery exists through Socket.IO, enabling live prices, account warnings, and support interactions."),
  );
  children.push(
    bullet("Platform settings, tenant settings, and billing constructs already exist, reducing the future work needed for SaaS packaging."),
  );
  children.push(
    bullet("Admin workflows cover the operational realities of a prop platform: KYC, payouts, violations, accounts, disputes, and tenant management."),
  );
  children.push(
    paragraph(
      "The current state also shows a practical commercial path. You can keep operating your own firm, refine the economics, and simultaneously use the same platform as the basis for white-label SaaS sales. That is more capital-efficient than trying to build separate products for each revenue stream. The report therefore treats the current project not as a generic fintech app but as a dual-engine business platform: one engine for your own trading operation and one engine for recurring B2B software revenue.",
    ),
  );

  children.push(heading("Architecture and Technology Stack", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The architecture is well suited to the product category. React 19 provides the trader and admin interface, Express 5 handles the API layer, PostgreSQL is the source of truth, Socket.IO handles low-latency push updates, and Docker plus Nginx provide a practical deployment baseline. This is a conventional but sensible stack for a first serious prop and SaaS platform because it balances developer speed with sufficient runtime structure.",
    ),
  );
  children.push(
    createTable(
      ["Layer", "Role in the Platform", "Why It Matters Commercially"],
      [
        ["React 19 + Router 7", "Trader UX, admin UX, tenant branding surface", "Supports one universal frontend build with brand-specific overlays"],
        ["Express 5 API", "Auth, trading, billing, admin, tenant endpoints", "Keeps business logic inside a flexible JS service layer"],
        ["PostgreSQL", "Accounts, trades, users, payouts, settings, tenant data", "Provides durable ledger behavior and strong transactional guarantees"],
        ["Socket.IO", "Realtime prices, warnings, admin alerts, support streams", "Allows the platform to feel like a trading product instead of a static portal"],
        ["Redis-ready token cache", "Auth acceleration and future coordination", "Important for scale and safer session validation under growth"],
        ["Docker + Nginx", "Deployment, reverse proxying, SSL, container orchestration", "Makes white-label deployment and repeatable environments much easier"],
      ],
      { columnWidths: [1400, 2500, 3000] },
    ),
  );
  children.push(
    paragraph(
      "A notable strength is that the codebase already expresses key domain boundaries. There are route modules for accounts, trades, payouts, auth, billing, disputes, chat, KYC, admin, and tenant management. There are services for progression, tenant policy, news, and violations. The platform also includes billing tiers in code, tenant-aware configuration, and a price feed layer that can evolve into more mature broker and market data orchestration.",
    ),
  );
  children.push(
    paragraph(
      "There are also architectural trade-offs to keep in mind. The documentation notes that server.js still carries too much orchestration, that some schema lifecycle is split between migrations and runtime initialization, and that deeper worker separation would improve clarity. Those are real issues. They do not invalidate the stack; they simply define the next hardening steps if the platform is pushed deeper into multi-tenant SaaS scale.",
    ),
  );

  children.push(heading("Core Trading, Challenge, Funded, and Admin Workflows", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "Operationally, the product is built around a clear lifecycle. A trader registers, completes onboarding and KYC where needed, starts a challenge, trades through phase 1 and phase 2 under rule enforcement, and either fails, expires, or reaches funded status. Once funded, the trader can continue operating until they request a payout or breach funded drawdown rules. That lifecycle is the center of both your own-firm model and any future tenant's business model.",
    ),
  );
  children.push(
    bullet("Phase 1 is the first evaluation gate, usually around a 10% profit target with a 10% drawdown ceiling."),
  );
  children.push(
    bullet("Phase 2 is the second evaluation gate, usually around a 5% target with a 5% drawdown ceiling."),
  );
  children.push(
    bullet("Funded accounts have no evaluation target in the model but still carry funded drawdown rules and profit-split logic."),
  );
  children.push(
    bullet("Admin users can review users, accounts, payouts, violations, chats, disputes, branding, tenants, and billing settings."),
  );
  children.push(
    paragraph(
      "Because the platform includes both trader-facing and admin-facing flows, it can support a real operations rhythm. Traders see challenge progress, account stats, charts, and payout interactions. Admins see exposure, violations, KYC queues, payout queues, and tenant configuration. That matters for the report because it means the projection is built on a platform that already expresses the core workflows needed to capture, manage, and monetize traders.",
    ),
  );

  children.push(heading("White-Label SaaS Positioning", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The white-label opportunity is one of the strongest strategic assets in the project. Instead of keeping the platform as an internal-only engine, you can sell the same stack to other prop firms that want their own brand, traders, rules, and admin users. The repo already contains tenant branding, tenant billing, tenant routing, and tenant-specific settings, which means the foundation for SaaS monetization exists in code today.",
    ),
  );
  children.push(
    createTable(
      ["Plan", "Code-Confirmed Monthly Price", "Intended Trader Limit"],
      SAAS_PLANS.map((plan) => [
        plan.name,
        formatCurrency(plan.price),
        plan.traderLimit ? `${formatNumber(plan.traderLimit)} active traders` : "Unlimited / enterprise negotiated",
      ]),
      { columnWidths: [1600, 1800, 3700] },
    ),
  );
  children.push(
    paragraph(
      "This recurring SaaS layer changes the risk profile of the whole business. Your own-firm trading edge is operationally attractive, but it is still tied to trader behavior, pass rates, and funded performance. SaaS subscription revenue is different: it is recurring, contractual, and much easier to forecast once tenant count stabilizes. That is why the model in this report treats SaaS MRR as a strategic stabilizer, not just an optional extra.",
    ),
  );
  children.push(
    paragraph(
      "An additional advantage of the white-label path is that each tenant firm becomes a source of both subscription margin and, where enabled, revenue-share upside on paid challenges. Even if your own firm remains free-to-enter, tenants may choose paid challenge models. That creates a second order revenue stream without forcing you to change the positioning of your own flagship firm.",
    ),
  );

  children.push(heading("Your Own Free-Prop Model", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "Your own prop brand is not based on challenge fees. Traders use your own firm for free. That is a major strategic distinction because it means your own trader acquisition can be positioned around accessibility and conversion rather than around immediate fee monetization. Commercially, the economic engine comes from how evaluation-stage trades are handled on the broker side and how funded traders are managed once they reach live status.",
    ),
  );
  children.push(
    paragraph(
      "That creates a two-speed operating model. At the top of the funnel, free access removes a major barrier for trader acquisition and may increase registration and account-start conversion. Deeper in the funnel, the evaluation and funded economics are monetized through trade execution behavior rather than upfront payments. This can be powerful if the challenge rules are strong, the funnel produces enough trader volume, and the edge is protected by disciplined risk controls.",
    ),
  );
  children.push(
    paragraph(
      "The model is therefore best understood as a hybrid of marketing and execution edge. Free entry can make the brand attractive, but the brand only becomes valuable if the evaluation funnel produces more reverse-trade edge than funded-stage losses, operating costs, and support burden. The projections in this report explicitly separate those layers so the economics are not hidden inside one blended number.",
    ),
  );

  children.push(heading("B-book and A-book Execution Logic", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The core trading logic used in this report follows your confirmed model exactly. Phase 1 and phase 2 accounts are treated as B-booked by reverse-trading the trader's actions on a real broker. In plain terms, when the trader buys, the broker-side hedge sells; when the trader loses, the broker-side book profits; when the trader wins enough to pass, the broker-side book gives back PnL. Funded accounts are different: they are A-booked 1:1 with live money, so the firm and trader are effectively aligned on profitable performance while the trader receives 80% of profits and the firm keeps 20%.",
    ),
  );
  children.push(
    createTable(
      ["Stage", "Execution Treatment in This Model", "Commercial Meaning"],
      [
        ["Phase 1", "Reverse-traded B-book on real broker", "Designed to monetize evaluation inefficiency and trader failure against disciplined risk limits"],
        ["Phase 2", "Reverse-traded B-book on real broker", "Second filter with lower target and lower drawdown, still monetized through reverse execution"],
        ["Funded", "A-booked 1:1 on real broker capital", "Trader profitability matters, but the firm retains 20% of profitable performance after payout"],
      ],
      { columnWidths: [1200, 2800, 2900] },
    ),
  );
  children.push(
    paragraph(
      "The most important implication is that evaluation revenue and funded revenue should never be blended without explanation. Evaluation-stage economics benefit from trader loss and failure rates. Funded-stage economics depend on the quality of traders who survive the funnel and on the firm's residual share after payouts. Those two books behave differently and should be measured differently. This report therefore models them as separate revenue lines every month.",
    ),
  );
  children.push(
    paragraph(
      `Your leverage assumptions are also important. Demo accounts are treated at ${DEMO_LEVERAGE_LABEL}, while the real broker side is modeled at ${REAL_BROKER_LEVERAGE_LABEL}. This does not mean ${formatCurrency(START_CAPITAL)} magically funds the full displayed virtual notional. It means that capital discipline is tied to drawdown and live margin usage rather than to the headline size of the virtual account balances.`,
    ),
  );

  children.push(heading("Revenue Model Breakdown", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The report uses four explicit revenue lines. The first is evaluation-stage B-book revenue from the reverse-traded phase 1 and phase 2 book. The second is funded-stage firm share from A-booked live traders after applying the 80/20 profit split. The third is SaaS subscription revenue from tenant firms on Starter, Growth, and Enterprise tiers. The fourth is optional tenant revenue share from tenant challenge sales where that feature is enabled.",
    ),
  );
  children.push(
    bullet("Evaluation-stage B-book revenue is the earliest and most direct economic engine in the model."),
  );
  children.push(
    bullet("Funded A-book revenue is modeled more conservatively because it depends on the quality of the traders who pass the funnel."),
  );
  children.push(
    bullet("SaaS subscription revenue becomes increasingly important after the first few months because it is recurring and lower-volatility than trading economics."),
  );
  children.push(
    bullet("Tenant revenue share is treated as secondary upside, not as the core case, because it depends on tenant pricing behavior and challenge volume."),
  );
  children.push(
    paragraph(
      "Separating the revenue lines makes the business easier to manage. If evaluation economics weaken, you can still observe whether SaaS is offsetting the pressure. If SaaS slows, you can still see whether your own-firm trading edge is strong enough to keep funding platform growth. That kind of transparency is crucial for decision-making, especially once you begin juggling platform engineering, trader acquisition, broker relationships, and tenant support at the same time.",
    ),
  );

  children.push(heading("Cost Structure and Operating Model", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "A full P&L basis is used throughout the projection. The cost stack includes hosting and infrastructure, broker and market-data tooling, development and maintenance, support and operations, software subscriptions, and a contingency layer tied to revenue. This approach is stricter than a gross-margin-only model, but it is healthier because it shows whether the business can actually support itself as an operating company rather than only as a trading hypothesis.",
    ),
  );
  children.push(
    createTable(
      ["Cost Category", "How It Is Treated in the Model", "Why It Is Included"],
      [
        ["Infrastructure", "Recurring fixed monthly cost with inflation", "Servers, storage, database, monitoring, SSL, and platform hosting do not disappear as volume grows"],
        ["Broker / feed / bridge", "Part of fixed and variable cost stack", "Real-money execution, data feeds, and bridge tooling are central to both your own firm and white-label tenants"],
        ["Development / maintenance", "Fixed monthly platform cost", "The product must continue shipping fixes and hardening, especially as tenants arrive"],
        ["Support / operations", "Variable cost tied to tenants and funded accounts", "Human handling grows with active traders, funded traders, and tenant count"],
        ["Contingency", "Percentage of revenue", "Captures slippage, chargebacks, refunds, and unplanned operational friction"],
      ],
      { columnWidths: [1600, 2700, 2600] },
    ),
  );
  children.push(
    paragraph(
      "The cost model is still deliberately conservative in one sense: it assumes disciplined founder-led operations instead of a large team from day one. That fits the starting capital profile. It would be unrealistic to model a full executive payroll stack on a ${formatCurrency(START_CAPITAL)} opening base. Instead, the report assumes a lean operator model that still acknowledges real software and support costs.",
    ),
  );

  children.push(heading("Financial Modeling Methodology", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The projection begins in May 2026 and runs for 36 monthly batches through April 2029. Each month is treated as one batch cycle. At the end of each month, 80% of net profit is added to deployable capital for the next batch and 20% is retained in reserve. If a month is negative, the loss is first absorbed by reserve and then by deployable capital. This makes the model behave like a real operating business rather than a spreadsheet that only moves upward.",
    ),
  );
  children.push(
    paragraph(
      `Stage growth is driven by a practical ladder. The opening batch is 50 virtual ${formatCurrency(1000)} accounts, which requires ${formatCurrency(5000)} of phase 1 drawdown capital at a 10% maximum drawdown. As deployable capital rises, the model steps into larger stages such as 75 x $1k, 100 x $1k, 100 x $2k, 150 x $2k, and eventually 200 x $5k. This respects your instruction that both account count and account size should expand over time.`,
    ),
  );
  children.push(
    paragraph(
      "The projections are not presented as live measured KPIs. They are modeled scenarios grounded in the repo, the operating logic you confirmed, and explicit assumptions about pass rates, tenant acquisition, ARPU mix, and costs. Every scenario assumption is shown later in the appendix so the model can be edited rather than treated as a black box.",
    ),
  );
  children.push(chartParagraph(baseRevenueMixChart));
  children.push(chartParagraph(baseCapacityChart));

  children.push(heading("Capital Usage, Drawdown Logic, and Leverage Interpretation", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "A major question in any report built around small starting capital is whether the opening structure is realistic. In your case, the answer depends on understanding the difference between virtual notional, drawdown capital, and broker margin. Fifty virtual $1,000 accounts equal $50,000 of displayed challenge notional, but that does not mean you need $50,000 of cash. Under your model, the practical risk anchor is drawdown. At a 10% phase 1 drawdown, the gross risk-capital requirement is $5,000. That is why the opening structure is coherent on paper.",
    ),
  );
  children.push(
    paragraph(
      `Broker leverage at ${REAL_BROKER_LEVERAGE_LABEL} further reduces margin friction on the execution side, while demo accounts at ${DEMO_LEVERAGE_LABEL} define the trader-side experience. The report still treats the ${formatCurrency(5000)} starting pool seriously. It does not assume unlimited simultaneous exposure or infinite fill quality. It simply interprets your model the way you described it: real capital is used against drawdown-based execution capacity rather than against the full displayed face value of virtual accounts.`,
    ),
  );
  children.push(
    bullet("Virtual account size is a marketing and trader-experience number; it is not the same thing as cash sitting idle."),
  );
  children.push(
    bullet("Phase 1 drawdown capital is the first real capacity gate in the model, which is why 50 x $1k maps directly to the opening $5k."),
  );
  children.push(
    bullet("Broker leverage lowers margin usage, but it does not remove economic risk. That is why the report still uses staged scaling rather than a linear infinite-capacity assumption."),
  );

  children.push(heading("Conservative Projection", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The conservative scenario assumes weaker evaluation-stage edge, slower SaaS adoption, slower plan upgrades, and a more expensive operating profile relative to scale. This case is useful because it stress-tests whether the business can survive without ideal conditions. It does not assume failure; it assumes friction.",
    ),
  );
  projectionHighlights(scenarios[0]).forEach((text) => children.push(paragraph(text)));
  children.push(
    paragraph(
      "Even in the conservative case, the blended model matters. Own-firm evaluation revenues still generate gross contribution, and white-label subscriptions gradually become a stabilizer. The conclusion is not that the business explodes upward immediately. The conclusion is that a careful operator can remain in the game long enough for SaaS recurring revenue to start carrying a meaningful part of the fixed-cost base.",
    ),
  );
  children.push(buildScenarioAssumptionsTable(scenarios[0]));

  children.push(heading("Base Projection", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The base scenario is the operating center of the report. It assumes steady monthly tenant acquisition after launch, no miracle-level trader edge, and a realistic but healthy conversion funnel from phase 1 to phase 2 to funded. It is neither promotional nor overly defensive. It is the scenario that best represents disciplined execution with a credible product and a founder who keeps shipping.",
    ),
  );
  projectionHighlights(baseScenario).forEach((text) => children.push(paragraph(text)));
  children.push(
    paragraph(
      "In this scenario, the business becomes more balanced over time. Early months lean more on evaluation-stage economics because SaaS MRR is still small. Mid-period months show the white-label engine taking more of the load. By later periods, blended revenue is meaningfully diversified: your own firm still matters, but recurring B2B software revenue becomes a visible economic pillar instead of just a future option.",
    ),
  );
  children.push(buildScenarioAssumptionsTable(baseScenario));

  children.push(heading("Aggressive Projection", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The aggressive scenario assumes better conversion, faster SaaS adoption, earlier plan upgrades, and stronger monetization from both funded traders and tenant revenue share. It is intentionally ambitious. The purpose is not to promise these numbers. The purpose is to show what the existing product could support if market response is strong and execution remains disciplined.",
    ),
  );
  projectionHighlights(scenarios[2]).forEach((text) => children.push(paragraph(text)));
  children.push(
    paragraph(
      "This scenario shows the power of your blended model. When evaluation edge, funded firm share, and SaaS recurring revenue all work at the same time, the business can scale much faster than a pure prop firm or a pure small SaaS platform on its own. The caution is that the aggressive case also demands stronger operational maturity, better support, tighter broker coordination, and more disciplined product hardening to avoid breaking under success.",
    ),
  );
  children.push(buildScenarioAssumptionsTable(scenarios[2]));
  children.push(chartParagraph(scenarioMonth36Bar));

  children.push(heading("Scenario Comparison and Sensitivity", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The three scenarios are best read as a sensitivity frame rather than as three random stories. The variables doing the most work are evaluation-stage trader outcomes, tenant acquisition pace, tenant churn, tenant plan mix, funded-book quality, and cost discipline. Small changes in those levers compound over 36 months because the model reinvests 80% of net profit back into deployable capacity.",
    ),
  );
  children.push(
    bullet("If evaluation-stage traders lose slightly more before failing, the B-book line strengthens quickly because the business is mirrored against a large batch volume."),
  );
  children.push(
    bullet("If white-label tenant acquisition is slower, the platform remains more dependent on trading economics and takes longer to build recurring cash flow."),
  );
  children.push(
    bullet("If tenant mix upgrades from Starter to Growth and Enterprise faster, SaaS MRR becomes a much stronger stabilizer."),
  );
  children.push(
    bullet("If funded traders underperform after passing, the A-book line weakens, but the damage is partially offset if SaaS MRR is already strong."),
  );
  children.push(
    paragraph(
      "That is why the platform strategy is strong. You are not relying on one number. You are building a stack where one business line can reduce the fragility of the other. A conventional prop firm without software revenue is exposed to trading behavior. A small SaaS business without a differentiated product can be exposed to long sales cycles. Your model blends a live operating firm with a reusable white-label product, which creates more than one path to scale.",
    ),
  );

  children.push(heading("Key Risks and Mitigations", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The first major risk is execution-risk misunderstanding. Reverse-trading evaluation phases can look attractive on paper, but real execution quality, symbol behavior, spread conditions, slippage, and trade clustering matter. Mitigation comes from treating the live exposure table and broker bridge as operating-critical systems rather than as passive utilities. You already have exposure and admin tooling in the repo; those should continue to be hardened and monitored closely.",
    ),
  );
  children.push(
    paragraph(
      "The second major risk is funded-book quality. Passing traders are not guaranteed to remain profitable after they reach funded status. A-booking funded accounts means the firm shares in real results, good or bad. The mitigation is to keep funded risk rules disciplined, maintain payout reviews, and watch the profitability distribution of funded cohorts instead of assuming all passers are automatically valuable.",
    ),
  );
  children.push(
    paragraph(
      "The third major risk is operational complexity from running two businesses at once. A firm that serves its own traders and sells to tenants also inherits support, compliance, onboarding, billing, and uptime obligations. Mitigation comes from productizing the platform deeply: strong tenant settings, safe billing flows, reliable support tooling, and clean admin permissions. The fact that the repo already contains much of this is encouraging, but it also means continued hardening is non-negotiable.",
    ),
  );

  children.push(heading("Execution Roadmap", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The operating roadmap implied by the report is straightforward. First, continue using the platform to refine your own-firm economics and collect real evidence on trader behavior, pass rates, and funded performance. Second, keep packaging the platform for white-label sale by hardening tenant management, billing, and operational documentation. Third, let SaaS MRR become the recurring cash layer that finances stronger infrastructure, support, and risk operations.",
    ),
  );
  children.push(
    bullet("Short term: keep improving execution reliability, risk monitoring, and financial instrumentation inside your own firm."),
  );
  children.push(
    bullet("Medium term: convert the strongest tenant-ready features into a cleaner onboarding and billing flow for white-label firms."),
  );
  children.push(
    bullet("Long term: use SaaS recurring revenue to support a more durable operating company rather than relying only on trading-derived cash generation."),
  );
  children.push(
    paragraph(
      "The platform does not need to be perfect before it starts producing strategic value. It needs to be controlled, measured, and improved in a way that compounds. That is especially true for a founder-led prop and SaaS business where each new feature can serve both your own operation and future client firms.",
    ),
  );

  children.push(heading("Conclusion", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "This project is already a meaningful asset. The repository is not just a trading dashboard or a thin challenge site. It is a serious prop-firm operating platform with tenant-aware structure, admin depth, and room for further SaaS hardening. Your business model adds another layer of leverage because it allows the same platform to monetize both your own trading operation and third-party prop firms.",
    ),
  );
  children.push(
    paragraph(
      `Starting from ${formatCurrency(START_CAPITAL)} is not a guarantee of speed, but it is enough to justify a disciplined first stage under your drawdown-based interpretation. The real decision is not whether the project can be modeled. It clearly can. The real decision is whether you continue turning it into a measured operating company: controlling risk, validating funnel behavior, and letting recurring SaaS revenue reduce dependence on any one trading outcome.`,
    ),
  );

  addPageBreak(children);

  children.push(heading("Appendix A: Scenario Assumptions", HeadingLevel.HEADING_1));
  children.push(
    paragraph(
      "The appendix below lists the major operating assumptions used in the model. These are not claimed as live measured KPIs. They are scenario inputs designed to translate your confirmed execution logic into a structured 36-month projection.",
    ),
  );
  scenarios.forEach((scenario) => {
    children.push(heading(`${scenario.name} Assumptions`, HeadingLevel.HEADING_2));
    children.push(paragraph(scenario.description));
    children.push(buildScenarioAssumptionsTable(scenario));
  });

  addPageBreak(children);

  children.push(heading("Appendix B: Conservative Monthly Projection", HeadingLevel.HEADING_1));
  children.push(paragraph("Financial table"));
  children.push(buildProjectionTable(scenarios[0].rows));
  children.push(paragraph("Operating table"));
  children.push(buildOperationsTable(scenarios[0].rows));

  addPageBreak(children);

  children.push(heading("Appendix C: Base Monthly Projection", HeadingLevel.HEADING_1));
  children.push(paragraph("Financial table"));
  children.push(buildProjectionTable(baseScenario.rows));
  children.push(paragraph("Operating table"));
  children.push(buildOperationsTable(baseScenario.rows));

  addPageBreak(children);

  children.push(heading("Appendix D: Aggressive Monthly Projection", HeadingLevel.HEADING_1));
  children.push(paragraph("Financial table"));
  children.push(buildProjectionTable(scenarios[2].rows));
  children.push(paragraph("Operating table"));
  children.push(buildOperationsTable(scenarios[2].rows));

  const doc = new Document({
    creator: REPORT_AUTHOR,
    title: REPORT_TITLE,
    description:
      "Detailed project report and 36-month financial projection for a PropFirm platform.",
    styles: {
      default: {
        document: {
          run: {
            font: "Aptos",
            size: 22,
          },
          paragraph: {
            spacing: { line: 300 },
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(0.8),
              right: convertInchesToTwip(0.7),
              bottom: convertInchesToTwip(0.8),
              left: convertInchesToTwip(0.7),
            },
          },
        },
        children,
      },
    ],
  });

  fs.writeFileSync(DATA_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), scenarios }, null, 2));

  Packer.toBuffer(doc).then((buffer) => {
    fs.writeFileSync(OUTPUT_PATH, buffer);
    console.log(`Generated report: ${OUTPUT_PATH}`);
    console.log(`Generated model data: ${DATA_PATH}`);
  });
}

main();
