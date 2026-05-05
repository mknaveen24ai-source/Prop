# PropFirm SaaS Build And Operations Guide

## Purpose
This guide explains how your platform works as a white-label SaaS product, how to build and launch tenants on it, and how to operate the business day to day.

## 1. Platform Summary
Your system is a multi-tenant prop-firm platform built on one shared codebase.

It supports two business models at the same time:
- Your own prop firm runs as the default tenant and can stay free for traders.
- External prop firms run as paid SaaS tenants and can choose free or paid challenge models.

The platform uses:
- Backend: Node.js, Express 5, PostgreSQL, Socket.io, JWT
- Frontend: React 19, React Router 7, vanilla CSS
- Runtime engines: challenge engine, progression service, live price feed, trade execution loops
- Infra: Docker, Nginx, Redis-ready architecture, MT5 bridge via DWX

## 2. Business Model
There are three levels in the platform:
- Platform Owner: you
- Tenant Prop Firm: your SaaS customer
- Trader: the end user of a tenant prop firm

Your revenue can come from:
- B-book profit from your own default firm
- Monthly SaaS subscriptions from tenant prop firms
- Optional revenue share on tenant challenge fees

Each tenant can operate differently:
- Free onboarding for traders
- Paid challenge checkout for traders
- Shared platform feed
- Dedicated MT5 feed
- Custom branding, domain, rules, and admins

## 3. How The SaaS Architecture Works
The platform is one backend and one frontend build, but every request is resolved to a tenant.

The tenant is identified by:
- subdomain, for example `firma.myplatform.com`
- custom domain, for example `trading.firma.com`
- fallback tenant slug in development or preview mode

Core concept:
- Every tenant-owned record is linked to `tenant_id`.
- Tenant settings define rules, branding, billing mode, and feed behavior.
- Tenant-aware middleware injects tenant context into requests.
- Tenant-aware auth ensures users and admins stay inside their tenant boundary.

Important backend modules:
- `backend/utils/tenants.js`: tenant resolution, tenant domains, default tenant bootstrapping
- `backend/routes/tenant.js`: runtime tenant config API used by the frontend
- `backend/routes/auth.js`: tenant-aware trader registration and login
- `backend/routes/middleware.js`: trader, tenant-admin, and super-admin auth controls
- `backend/routes/accounts.js`: challenge purchase, challenge creation, rules, availability
- `backend/routes/billing.js`: tenant SaaS subscriptions and tenant trader challenge checkout
- `backend/priceFeed.js`: shared and tenant-aware price feed logic
- `backend/challengeEngine.js`: pass, fail, expiry, and challenge automation

## 4. Core Tenant Model
Each tenant has:
- identity: `slug`, `name`, `status`
- domains: platform subdomain and optional custom domains
- branding: logo, colors, text content
- rules: drawdown, profit targets, time limits, payout share, challenge mode
- admins: tenant-specific admin accounts
- billing: plan, subscription status, Stripe details
- feed configuration: shared feed or dedicated feed

Important tenant tables:
- `tenants`
- `tenant_domains`
- `tenant_settings`
- `tenant_admins`
- `tenant_subscriptions`
- `tenant_subscription_events`
- `tenant_price_feeds`

Important tenant-owned business tables include:
- `users`
- `accounts`
- `trades`
- `payouts`
- `support_tickets`
- `support_ticket_messages`
- `chat_conversations`
- `chat_messages`
- `disputes`
- `challenge_orders`
- `challenge_payments`
- `challenge_checkout_sessions`

## 5. How A New SaaS Tenant Is Created
The tenant creation flow is:

1. A super-admin creates or signs up a new tenant.
2. A tenant row is created in `tenants`.
3. Default tenant settings are inserted into `tenant_settings`.
4. Tenant admin credentials are created in `tenant_admins`.
5. Domain records are created in `tenant_domains`.
6. Feed configuration is created in `tenant_price_feeds`.
7. SaaS subscription data is created in `tenant_subscriptions`.
8. The frontend automatically loads the tenant by domain and branding config.

The tenant can then configure:
- logo and colors
- support email
- challenge pricing
- challenge mode: free or paid
- Stripe keys
- feed mode: shared or dedicated

## 6. How Trader Onboarding Works
The trader journey is tenant-scoped from the first page load.

### Registration
The trader registers through a tenant-branded UI.

On registration the platform:
- resolves the tenant
- validates the user under that tenant
- stores the user with `tenant_id`
- returns a tenant-aware JWT

### Login
On login the platform:
- verifies password
- checks bans and token version
- confirms the trader belongs to the current tenant
- issues a tenant-aware JWT

### Starting A Challenge
The challenge flow depends on the tenant setting:

- Free tenant:
  - trader starts the challenge directly
  - account is created immediately if quota and rules allow

- Paid tenant:
  - trader creates a challenge order
  - checkout session is created
  - payment must complete successfully
  - account is created only after the order is paid

## 7. How Trading Works
After a challenge account is created:
- the trader places trades through the trading UI
- prices are received by API and Socket.io
- tenant-specific spread markup can be applied
- trade rules are enforced per tenant

Main runtime logic:
- `routes/trades.js`: order placement, pending order triggers, SL and TP handling, floating drawdown checks
- `priceFeed.js`: live prices, history writes, feed-source handling
- `challengeEngine.js`: periodic challenge review
- `progressionService.js`: challenge progression and funded promotion

## 8. How Challenge Evaluation Works
The challenge engine runs in the background and checks active accounts.

It can:
- fail accounts for drawdown breaches
- expire accounts when time limits are reached
- promote passed accounts
- record metrics into reporting tables
- send trader notifications and emails

The rules it uses are not global anymore. They come from tenant settings, such as:
- phase 1 profit target
- phase 2 profit target
- max drawdown
- time limit
- inactivity fail settings
- payout share

## 9. How Billing Works
There are two billing systems in the product.

### A. SaaS Billing For Tenant Firms
This is how tenant firms pay you.

It is handled by:
- `tenant_subscriptions`
- `tenant_subscription_events`
- Stripe checkout and webhook processing

SaaS billing supports:
- subscription checkout
- billing portal
- webhook updates
- grace periods
- suspension and reactivation

### B. Challenge Billing For Tenant Traders
This is how a tenant firm can charge its traders.

It is handled by:
- `challenge_orders`
- `challenge_checkout_sessions`
- `challenge_payments`

This lets each tenant choose:
- `free` challenge model
- `paid` challenge model

## 10. Your Own Free Firm Versus Paid Tenant Firms
Your own firm is simply the default tenant.

That means:
- you do not need a separate codebase for your own prop business
- you can keep your own tenant on `requires_payment=false`
- tenant customers can use `requires_payment=true`
- all firms still use the same platform, same engines, and same frontend build

In practice:
- your traders can sign up and start challenges without payment
- tenant traders can be required to pay first
- your own firm profit can come from B-book
- tenant revenue comes from SaaS billing and optional revenue share

## 11. How Admin Roles Work
There are two main admin levels:

### Super Admin
This is you and trusted platform operators.

Super-admin powers include:
- tenant creation and updates
- tenant billing control
- platform-wide admin command center
- account recovery tools
- tenant suspension and reactivation
- domain management
- access across all tenants

### Tenant Admin
This is the admin for a SaaS customer.

Tenant-admin powers include:
- viewing their own traders
- reviewing KYC
- reviewing payouts
- viewing disputes and chat
- operational moderation inside their own tenant only

They should not:
- manage other tenants
- access platform-wide billing
- use super-admin bulk recovery tools

## 12. How Branding And Domains Work
The frontend is one universal React application.

On startup it calls:
- `GET /api/tenant/config`

That endpoint returns:
- tenant name
- logo
- colors
- settings
- subscription state
- features
- domain records

This makes white-label behavior possible without separate builds.

Domains work through:
- `tenant_domains`
- host-based tenant resolution in `tenants.js`
- Nginx forwarding the original host to the backend

Supported models:
- platform subdomain
- custom domain with tenant record and verification status

## 13. How Price Feeds Work
The platform supports a hybrid feed model.

### Shared Feed
One platform feed can serve many tenants.

Use this when:
- a tenant does not have its own MT5
- you want fast onboarding
- you want centralized pricing

### Dedicated Feed
A tenant can have its own MT5 or feed configuration.

Use this when:
- a tenant needs custom execution or pricing
- a tenant wants its own data source

### Tenant Spread Markup
Even when using a shared raw feed, the price shown and used for a tenant can be adjusted by tenant spread markup.

This lets you:
- serve one shared raw feed
- give each tenant different effective spreads

## 14. How Security And Isolation Work
Tenant safety depends on multiple layers:

### Application Layer
- tenant resolution from host or slug
- tenant-aware JWTs
- tenant-aware admin auth
- tenant filters in business queries
- tenant-specific socket rooms

### Database Layer
- `tenant_id` on tenant-owned tables
- request-scoped DB context
- RLS scaffolding and isolation infrastructure

### Operational Controls
- rate limiting
- token versioning
- immutable audit logs
- admin capability checks
- super-admin-only dangerous actions

## 15. Daily Operations Model
To run the SaaS day to day, you work in five loops.

### 1. Tenant Operations
- onboard new tenant
- configure branding and billing
- verify domain
- activate or suspend tenant as needed

### 2. Trader Operations
- monitor registrations
- monitor KYC
- monitor account creation and challenge activity
- monitor disputes and support tickets

### 3. Risk Operations
- monitor violations
- review flagged payouts
- review breached or recovered accounts
- watch challenge engine results

### 4. Billing Operations
- watch Stripe webhook health
- review past-due tenants
- review failed tenant renewals
- review tenant trader payment flow if tenant uses paid challenges

### 5. Infrastructure Operations
- monitor backend health
- monitor feed freshness
- monitor MT5 file watcher health
- monitor slow SQL and background jobs

## 16. How To Launch A New Tenant In Practice
Recommended practical tenant-launch sequence:

1. Create tenant as super-admin.
2. Set branding and support details.
3. Create tenant admin login.
4. Set challenge rules.
5. Decide free or paid challenge model.
6. Add Stripe public and secret keys if paid mode is needed.
7. Configure domain and verify DNS.
8. Choose shared feed or dedicated feed.
9. Smoke test registration, login, challenge start, prices, and payout flow.
10. Activate tenant and hand over admin access.

## 17. How To Work With The SaaS As Owner
As platform owner, you should think in these layers:

### Product Layer
- build a strong default tenant experience
- let tenants customize enough without breaking platform integrity

### Revenue Layer
- keep your own default tenant profitable
- charge SaaS subscriptions by plan
- optionally monetize tenant challenge volume via revenue share

### Operations Layer
- keep feed runtime stable
- keep tenant isolation strong
- keep billing and admin tools reliable

### Support Layer
- help tenant admins launch faster
- give them enough self-service controls
- keep dangerous controls only for super-admins

## 18. Current Status Of Your Platform
Your platform is no longer just a single-firm prop app. It now has a real SaaS structure.

Already implemented in the codebase:
- tenant infrastructure
- tenant domains
- tenant settings
- tenant admins
- paid and free challenge modes
- subscription infrastructure
- tenant-aware branding
- super-admin and tenant-admin separation
- command center tooling
- tenant-aware trading and challenge runtime

Still important before a fully polished first commercial rollout:
- stabilize MT5 file permissions and stale feed behavior
- complete live Stripe end-to-end verification
- finish final production hardening and deployment checks
- complete full launch smoke testing for custom domains and billing lifecycle

## 19. Recommended Way To Explain The Product To Clients
Short version:

"Our platform is a white-label prop-firm SaaS. We provide the trading portal, trader dashboard, challenge engine, payout workflows, admin system, branding, billing, and live price infrastructure. Your firm gets its own tenant, domain, branding, rules, and admins on top of the shared platform."

## 20. Final Conclusion
Your system should now be viewed as:
- a multi-tenant white-label prop-firm operating system
- one product that runs your own firm and external SaaS clients
- a platform where the tenant is the core business unit

The operational rule is simple:
- your codebase stays shared
- your data stays tenant-scoped
- your frontend stays universal
- your business logic stays tenant-configurable
- your platform revenue and tenant revenue stay logically separated

## Appendix: Key Files
- `backend/server.js`
- `backend/utils/tenants.js`
- `backend/routes/tenant.js`
- `backend/routes/auth.js`
- `backend/routes/accounts.js`
- `backend/routes/billing.js`
- `backend/routes/middleware.js`
- `backend/routes/adminTenants.js`
- `backend/priceFeed.js`
- `backend/challengeEngine.js`
- `backend/services/tenantPolicyService.js`
- `frontend/src/BrandingContext.js`
- `frontend/src/utils/tenant.js`
