import React from 'react'
import LegalPage from '../components/legal/LegalPage'

/**
 * Cookie policy.
 *
 * Required alongside the Privacy Policy under the ePrivacy Directive for any
 * EU/UK visitor. The contents below reflect what this application actually
 * stores — an httpOnly `token` / `admin_token` session cookie plus a handful of
 * localStorage keys — rather than boilerplate about analytics vendors we do not
 * use. If a marketing pixel or analytics SDK is ever added, §4 must be updated
 * and a consent banner becomes mandatory.
 */
export default function CookiePolicy() {
  const sections = [
    {
      id: 'what',
      title: '1. What We Store',
      content: `We use a small number of strictly necessary cookies and browser-storage entries. We do not use advertising cookies, tracking pixels, or third-party analytics profiles.

Cookies (set by us, httpOnly, not readable by JavaScript):

token — your trader session. Set when you log in, cleared when you log out. httpOnly, Secure in production, SameSite=Strict.

admin_token — administrator session, for staff accounts only. Same protections, shorter lifetime (8 hours).

Browser localStorage (readable by the app, never sent automatically to the server):

Interface preferences such as your selected theme, dashboard block order, watchlist pins, and whether you have dismissed the risk warning banner.

A locally cached copy of your notifications so the bell is populated instantly on load.

Your email address, if you ticked "remember me" on the login form. Your password is never stored.`
    },
    {
      id: 'why',
      title: '2. Why We Use Them',
      content: `Authentication: the session cookie is what keeps you logged in between page loads. Without it the platform cannot function — you would be signed out on every navigation.

Security: the session cookie is httpOnly and SameSite=Strict, which is what prevents a malicious page in another tab from stealing your session or acting on your behalf.

Preferences: so the interface looks the way you left it, without a round trip to the server.

None of these are used to build an advertising profile, and none are shared with third parties.`
    },
    {
      id: 'consent',
      title: '3. Consent',
      content: `Cookies that are strictly necessary to deliver a service you have explicitly requested — such as keeping you logged in — do not require prior consent under the ePrivacy Directive and the UK PECR. All the cookies described in §1 fall into that category.

Because we set no analytics, advertising, or profiling cookies, we do not show a consent banner. If that ever changes, we will ask for your consent before setting any such cookie, and you will be able to refuse without losing access to the platform.`
    },
    {
      id: 'third-party',
      title: '4. Third-Party Content',
      content: `Two third parties can set cookies when their content loads:

TradingView — supplies the charting widget on the trading terminal. TradingView may set its own cookies to remember chart settings. See TradingView's own cookie policy for details.

Stripe — handles checkout. Stripe sets cookies necessary for payment processing and fraud prevention when you reach the payment step. See Stripe's cookie policy.

We do not control these cookies and cannot read them. We do not embed social media widgets, advertising networks, or session-recording tools.`
    },
    {
      id: 'manage',
      title: '5. Managing Cookies',
      content: `You can clear or block cookies through your browser settings. Be aware that blocking our session cookie will make it impossible to log in — the platform will appear to reject valid credentials, because the session cannot be established.

To clear the preference data we keep in localStorage, use your browser's "clear site data" option for this domain. Doing so resets your theme, dashboard layout, and watchlist, but does not affect your account, your accounts' balances, or your trading history, all of which live on the server.

Logging out clears the session cookie immediately.`
    },
    {
      id: 'changes',
      title: '6. Changes to This Policy',
      content: `If we introduce any cookie beyond those described here — particularly any analytics or marketing cookie — we will update this page and, where the law requires it, ask for your consent before setting it.

Material changes will be announced by email or by a notice on the platform. This policy should be read together with our Privacy Policy, which explains how we handle personal data more generally.`
    }
  ]

  return (
    <LegalPage
      title="Cookie Policy"
      intro={`This page lists every cookie and browser-storage entry this platform sets, and why.

Short version: one httpOnly session cookie to keep you logged in, some local preferences so the interface remembers your settings, and no advertising or analytics tracking of any kind.`}
      sections={sections}
      contactEmail="privacy@propfirm.com"
      contactLabel="For questions about cookies or data protection, contact"
    />
  )
}
