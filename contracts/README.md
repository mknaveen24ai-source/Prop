# PropFirm contracts

This package is declarations-only. It may contain public DTOs and event-map
types, but never schemas, constants, classes, functions, enums, side effects, or
other runtime values. Consumers must use `import type` and `export type`.

Database rows are private implementation details and must remain in the
application that owns the query. Runtime validators also remain application
local and are authoritative; data crossing HTTP, Socket.IO, Redis, webhook,
JWT, external API, MT5/DWX, or JSON/JSONB boundaries starts as `unknown`.

Contract conventions:

- IDs are strings.
- Timestamps are ISO-8601 strings.
- Persisted and wire-format money is a validated decimal string.
- `field?: T` means absent is permitted.
- `field: T | null` means the field is present and nullable.
- Existing legacy error responses remain modeled separately from versioned
  structured errors. TypeScript migration does not redesign response bodies.
