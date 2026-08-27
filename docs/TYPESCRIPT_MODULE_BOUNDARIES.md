# TypeScript module-boundary baseline

The backend remains CommonJS. This migration does not authorize converting
intentional lazy `require()` calls into static imports or changing module
initialization order.

`backend/scripts/check-module-boundaries.ts` scans tracked and newly authored
production modules, resolves static relative imports and `require()` calls,
detects strongly connected dependency components, and inventories `require()`
calls nested inside functions. CI compares the result with
`.typescript-migration-module-boundaries.json`; additions and stale entries
both fail until reviewed.

The Phase 3 baseline contains two existing cycles:

- `mailer` / `services/certificateService` / `utils/emailQueue`
- `priceFeed` / `utils/priceCache` / `utils/prometheusMetrics`

These cycles must keep their current lazy-load boundaries while their modules
are converted. Breaking either cycle is a separate behavior-preserving slice,
not an automatic import rewrite. A cycle may be removed from the baseline only
after compiled-module smoke tests and related behavior tests pass.

Lazy boundaries in route trade mutations, the server startup graph, scheduler
ownership, socket adapters, Redis access, trade index synchronization, logging,
and health reporting are likewise frozen in the machine-readable baseline.
External-package lazy loads are tracked too because an ESM-only or missing
runtime dependency must fail the compiled-output gate before deployment.
