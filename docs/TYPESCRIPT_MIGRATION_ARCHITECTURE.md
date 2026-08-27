# TypeScript migration architecture

## Module and runtime contract

**No ESM migration is permitted in this project.** The backend package remains
`"type": "commonjs"` throughout and after migration. TypeScript uses Node16
module resolution/emission with `verbatimModuleSyntax: false`; authored imports
may therefore compile to CommonJS `require`/`exports`. Intentional lazy
`require()` boundaries are preserved when they prevent circular initialization.
The frontend keeps its existing Vite-bundled behavior; converting its sources to
TypeScript is not an ESM migration.

CI, Docker builders, production images, `.node-version`, `.nvmrc`, and package
engines use exactly Node `24.19.0`. The production image is pinned to
`node:24.19.0-alpine3.24` and its recorded multi-architecture digest. Startup
logs Node/npm and rejects a different Node major/minor/patch.

`esModuleInterop: true` and `allowSyntheticDefaultImports: true` provide
compile-time ergonomics for compatible CommonJS packages. They do not change
package semantics and do not authorize ESM-only runtime dependencies.

Production executes `node --enable-source-maps dist/server.js`. External source
maps ship only inside the private image. They are not served by Express or
nginx, and `inlineSources` remains disabled.

## Boundary and contract policy

**All external data starts as `unknown`.** A local runtime validator must accept
it before application code treats it as a DTO. This covers HTTP bodies/query/
params, decoded JWTs, Socket.IO payloads and acknowledgements, parsed Redis JSON,
webhooks after signature verification, external APIs, MT5/DWX data, JSON/JSONB,
and frontend response JSON. Runtime schemas are authoritative. A TypeScript
assertion is not validation.

`@propfirm/contracts` is declarations-only and has no runtime entrypoint. It may
contain public DTOs and Socket.IO maps, never schemas or database rows. An AST
gate rejects enums, values, runtime exports, and non-type imports/exports.

IDs are strings, timestamps are ISO strings, and persisted/wire money is a
validated decimal string. Optional and nullable remain distinct. Application-
private query row interfaces model PostgreSQL numerics as strings and JSON as
`unknown`; named mappers produce public DTOs.

## Existing error bodies

Migration preserves each endpoint's current response shape:

- Most backend routes, including admin compliance, use legacy
  `{ "error": string }` failures.
- A smaller set of existing endpoints uses legacy `{ "message": string }`.
- Endpoints already using `{ "error": { "code", "message", "details" } }`
  are modeled as `ErrorResponseV1`.
- Socket authentication currently uses `{ "error": string }`; new structured
  socket errors are versioned as `SocketErrorV1` and cannot replace the legacy
  payload without a separate protocol change.

TypeScript conversion does not normalize these bodies, status codes, endpoint
URLs, headers, or Socket.IO event names.

## Runtime filesystem paths

Compilation must not redirect mutable or mounted paths below `dist`.
Production keeps `/app/uploads`, `/app/logs`, `/app/assets`, and the existing
`/app/mt5-bridge` mount. Runtime path helpers and Docker smoke tests enforce this
contract.
