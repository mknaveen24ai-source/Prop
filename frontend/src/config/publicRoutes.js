/**
 * The public route table — the single list of pages a crawler may index.
 *
 * One static <head> served all 59 routes, so every page shared one title and
 * one description, there was no sitemap anywhere in the repo, and robots.txt
 * said `Disallow:` — i.e. everything crawlable, /admin and /dashboard included.
 *
 * This list is consumed by three things that must not disagree:
 *
 *   1. vite.config.mjs      generates build/sitemap.xml from it
 *   2. useDocumentMeta()    titles and describes each page from it
 *   3. public/robots.txt    excludes everything NOT on it
 *
 * Keep it to genuinely public, genuinely indexable pages. /checkout, /login,
 * /register and /verify/:publicId are public but not indexable — a checkout
 * flow and a per-certificate permalink have nothing to rank for, and indexing
 * certificate URLs would publish traders' records to search.
 *
 * `changefreq` and `priority` are hints, not instructions; they are here
 * because a sitemap without them is strictly less useful and they cost nothing.
 */

export const SITE_NAME = 'Funded Trading Challenges'

export const PUBLIC_ROUTES = [
  {
    path: '/',
    title: 'Funded Trading Challenges | Trade Our Capital',
    description:
      'Prove your edge on a funded trading challenge and keep 100% of your profits — we take no cut. Live institutional pricing in a browser terminal, published rules, and fast payouts across forex, indices and metals.',
    changefreq: 'weekly',
    priority: '1.0'
  },
  {
    path: '/rules',
    title: 'The Rulebook — Every Rule, Before You Pay',
    description:
      'Every rule that can end an account, published in full before you buy: profit targets, trailing drawdown, daily loss limits, qualifying days, consistency and execution behaviour — read live from the platform’s own settings.',
    changefreq: 'weekly',
    priority: '0.9'
  },
  {
    path: '/transparency',
    title: 'Transparency — Pass Rates and Payouts, Published',
    description:
      'Live pass rates, total payouts, funded trader counts and payout latency, served from the platform’s own ledger. Not a marketing summary — the numbers themselves.',
    changefreq: 'daily',
    priority: '0.9'
  },
  {
    path: '/leaderboard',
    title: 'Trader Leaderboard',
    description: 'Top performing funded and evaluation traders, ranked on realised return.',
    changefreq: 'daily',
    priority: '0.7'
  },
  {
    path: '/competitions',
    title: 'Trading Competitions',
    description: 'Live and upcoming trading competitions, with prize pools, rules and standings.',
    changefreq: 'daily',
    priority: '0.7'
  },
  {
    path: '/terms',
    title: 'Terms of Service',
    description: 'The terms governing evaluation accounts, funded accounts and payouts.',
    changefreq: 'monthly',
    priority: '0.3'
  },
  {
    path: '/privacy',
    title: 'Privacy Policy',
    description: 'What personal data this platform collects, why, and how it is stored.',
    changefreq: 'monthly',
    priority: '0.3'
  },
  {
    path: '/refund-policy',
    title: 'Refund Policy',
    description: 'When an evaluation fee is refundable, and how a refund is processed.',
    changefreq: 'monthly',
    priority: '0.3'
  },
  {
    path: '/cookie-policy',
    title: 'Cookie Policy',
    description: 'The cookies this platform sets and what each one is for.',
    changefreq: 'monthly',
    priority: '0.3'
  }
]

/** Paths that must never be crawled — the source for robots.txt. */
export const DISALLOWED_PATHS = ['/admin', '/dashboard', '/checkout', '/verify', '/reset-password']

export function findPublicRoute(pathname) {
  return PUBLIC_ROUTES.find((route) => route.path === pathname) || null
}
