// Static single-tenant branding configuration.
//
// This product used to be a multi-tenant/white-label SaaS platform where each
// tenant's branding was fetched at runtime from `/api/tenant/config`. It is
// now a single-tenant product (one business, one brand), so branding is just
// a plain constant baked into the build instead of a network round trip.
//
// Update the values below to customize the deployed brand.
const branding = {
  name: 'PropFirm',
  logo_text: 'PropFirm',
  logo_url: null,
  support_email: null,
  email_from_name: 'PropFirm',
  settings: {
    max_accounts_per_user: '5',
    // Optional override for the "starting from $X" copy used across the
    // landing page. Leave blank to fall back to the default copy.
    challenge_fee_label: ''
  },
  brand: {
    short_name: 'PropFirm',
    tagline: 'Funded trading accounts with transparent rules.',
    hero_title: 'PropFirm | Funded Trading Accounts',
    hero_subtitle: 'Transparent rules, real progression, and institutional-grade infrastructure.',
    primary_color: null,
    accent_color: null
  }
}

export default branding
