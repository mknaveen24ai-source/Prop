# TypeScript Migration Phase 0 Baseline

Captured on 2026-08-25 before any TypeScript migration edits. This document is
evidence for comparison during later slices; it is not a production-capacity
certificate.

## Non-destructive workspace checkpoint

- Branch: `ui/consistency-2026-08-20`
- Original HEAD: `9e236b337cb3b0d9bce618c94288a75b8a962ca9`
- Checkpoint ref: `refs/codex/checkpoints/typescript-phase0-20260825`
- Checkpoint commit: `3aeb852237e30ca95410d594529c3ae68ee4f041`
- Checkpoint tree: `7f2cb123d11dc9fe6e42eb63657b6c15dcd492f9`
- Checkpoint delta from HEAD: 241 files, 21,078 insertions, 2,790 deletions
- Original worktree status: 54 staged entries, 178 unstaged entries, and 4
  untracked entries
- Original porcelain-status SHA-256:
  `ca7f8d85efb409e09224851ac9c37d2c5bdcff720f0efa6e26c2749449557b2f`

The checkpoint was created with an alternate Git index. It did not stage,
stash, commit to the active branch, or rewrite any existing work. Ignored
`.env`, uploads, logs, dependencies, and generated output are intentionally not
part of it.

To inspect or recover it without changing the active branch:

```sh
git show --stat refs/codex/checkpoints/typescript-phase0-20260825
git branch recover/typescript-phase0 refs/codex/checkpoints/typescript-phase0-20260825
```

## Runtime and dependency baseline

- Host: Fedora Linux `7.1.9-200.fc44.x86_64`, Node `22.23.1`, npm `10.9.8`
- Running backend and email-worker images: Node `20.20.2`, npm `10.8.2`
- Planned Phase 1 target: Node `24.19.0` in CI, builders, and production
- Backend image: `prop-backend:latest`, image ID prefix `e163992524be`
- Email-worker image: `prop-email-worker:latest`, image ID prefix `326807f58b2f`
- Migrate image: `prop-migrate:latest`, image ID prefix `b9a19d1fbb95`
- PostgreSQL: `postgres:18-alpine`
- Redis: `redis:7-alpine`

Installed migration-sensitive tools before pinning:

| Tool | Observed version |
| --- | ---: |
| backend ESLint | `10.8.1` |
| frontend ESLint | `9.39.5` |
| TypeScript | `5.9.3` |
| Vite | `8.2.1` |
| Vitest | `4.1.11` |
| Playwright | `1.62.1` |
| Storybook | `10.5.9` |

Package/configuration digests:

- `backend/package-lock.json`:
  `c58ea4fdd46f807c2422aa4283888e8a62c0b1a3f187a6a0f7c814d1356d628c`
- `frontend/package-lock.json`:
  `ac56281c16db4d455c31b43874b4a59b787cd86a1516554265d54055232796af`
- `e2e/package-lock.json`:
  `450840f5a15f29c47c999d237394200bb30acca3735f9ff8bb8f9bb90cddb94d`
- `docker-compose.yml`:
  `b2b76b73235222eed9758da1e0ec1a3f7063331bca45e709b55716c61592b9ca`

## Authored JavaScript inventory

Inventory source: `git ls-tree -r --name-only` against the checkpoint, so it
includes staged and previously untracked source without counting ignored build
output.

| Extension | Files |
| --- | ---: |
| `.js` | 422 |
| `.jsx` | 186 |
| `.mjs` | 3 |
| `.cjs` | 0 |
| **Total** | **611** |

Top-level ownership:

| Area | Authored JS files |
| --- | ---: |
| backend | 332 |
| frontend | 271 |
| e2e | 6 |
| root scripts | 2 |

Backend breakdown: 72 routes, 40 services, 51 utilities, 52 tests, 47
migrations, 36 scripts, 10 tools, 5 domain modules, 2 config modules, 1 worker,
and 16 root-level modules.

## Migration filename invariant baseline

- Source migration files: 47
- Ordered source-name list SHA-256:
  `8f81efcc9023b4a9bfe46962db9a170b1e59fb9741e2498c6063257e15839931`
- Running production migration status: 47 completed, zero pending
- Current Knex source extension and load extension: `.js`
- First migration names include `000_TEMPLATE.js`, `000_core_schema.js`, and
  `001_baseline_schema.js`; the latest is
  `045_two_person_payout_approval.js`.

The historical basename contract is the filename without the source extension.
Later `.ts` sources must emit the same basenames as `.js` under
`dist/migrations`, and the populated database must continue reporting zero
historical migrations pending.

## Validation baseline

| Gate | Result |
| --- | --- |
| Backend `npm test` | PASS: 504 tests, 11 suites, 0 failed/skipped |
| Backend `npm run check` | PASS: tracked-require check covered 331 files |
| Backend `npm run lint` | PASS |
| Frontend `npm test -- --reporter=dot` | PASS: 17 files, 166 tests |
| Frontend `npm run typecheck` | PASS |
| Frontend `npm run build` | PASS: 3,347 modules transformed |
| Storybook build | PASS |
| Playwright public smoke | PASS: 10 Chromium tests |
| Compose monolith config | PASS |
| Compose scale-out config | PASS |
| Compose scale-out dry-run | PASS |
| Container `knex migrate:status` | PASS: 47 completed, zero pending |

The previous known backend baseline was 502 tests. The current checkpoint has
504, so later unexplained reductions below 504 are migration regressions.

Representative unauthenticated REST fixtures captured from the running stack:

| Request | Status | Exact body |
| --- | ---: | --- |
| `GET /api/auth/me` | 401 | `{"error":"Access token required"}` |
| `POST /api/trades/open` | 401 | `{"error":"Access token required"}` |
| `GET /api/admin/enforcement/events` | 401 | `{"error":"Admin token required"}` |

Behavioral-test source digests anchor the current trade, socket, auth, payout,
and admin expectations until generated golden fixtures are added in later
slices:

- `test/tradesHttp.test.js`: `f7a5ee54e6cfc988e5189cb51af7c5940902e7302b5d495a87598ce39180da4f`
- `test/tradeEngine.test.js`: `cb3701f9e9c147306cb36428d903700a681cd794db259c451450593d9eaba43a`
- `test/eventEngine.test.js`: `8bdbdc5104671b6b87caa526af63b5fe6a23f5423f7e2d5682c63affd0624fac`
- `test/socketRevalidation.test.js`: `5e67a24700fcbc5e57b6a9f1a4cb1a7a076f5aca17dc742d40c11b339249ffc6`
- `test/challengeEngineLifecycle.test.js`: `e5864153cee7af7dd506f8b8b384b05a510bf9a2f57efb7b63a9a95481f3cef9`
- `test/payoutLifecycle.test.js`: `2d85361d0cd7dce73d817b92a7217a0ab7c8c27bde1cfd194371466084a3bad0`
- `test/payoutDualApproval.test.js`: `c81c2979e24114f2b8624ff15d722754f76d5be1478e7b32ff0805946e504ca1`
- `test/adminRoutes.test.js`: `ea39f02f35feaaa0c3662422866f0a76bcce6a0e054fe0014528a5dc34841bf7`

Known baseline warnings that are not migration failures:

- Frontend tests report jsdom canvas/scroll limitations and several React
  `act(...)` warnings while still passing.
- Storybook reports module-type reparsing for `.storybook/main.js`, no MDX
  stories, and large preview chunks.
- Backend tests intentionally exercise mocked pools and log connection-refused
  messages while passing.

## Read-only running-stack snapshot

- `/api/health`: healthy and launch-ready
- Database: healthy
- Redis: healthy
- Price feed: healthy, 45 of 45 symbols healthy
- Recent HTTP 5xx count: 0 in the health window
- Ten HTTPS health samples: average `0.015294s`, median `0.014626s`, maximum
  observed `0.019339s`
- Backend sample: 1.90% CPU, 106.6 MiB memory
- Email worker sample: 0.00% CPU, 16.95 MiB memory
- PostgreSQL sample: 1.90% CPU, 591.9 MiB memory
- Redis sample: 0.47% CPU, 7.238 MiB memory
- One-hour backend/worker log scan found no matching fatal, uncaught exception,
  unhandled rejection, Redis error, database error, or scheduler-lock error.

## Limitations and Phase 1 entry conditions

- The running images predate the TypeScript infrastructure and use Node 20;
  they are runtime evidence for the current deployment, not evidence for the
  planned Node 24/compiled build.
- The host cannot resolve the Compose-only PostgreSQL hostname, so host-side
  `npm run migrate:status` failed with `ECONNREFUSED`; the same command passed
  inside the running backend container.
- Phase 0 did not run destructive fresh-database provisioning, authenticated
  trade creation, the 10k-socket harness, or the 100k-trade harness.
- The existing engine-equivalence script was not run against the active stack:
  the currently running engine shares that database, and synthetic ticks must
  never race a live engine. Phase 5 must run baseline and candidate harnesses in
  isolated environments.
- No JS-versus-TS engine-equivalence result exists yet; that becomes blocking
  before the engine conversion is deployable.
- No capacity claim may be made from these unit, build, smoke, or sample metrics.

Phase 1 may begin only from the checkpoint above and must remain infrastructure
only: CommonJS TypeScript build/test configuration, exact version pins,
compiled-runtime smoke tests, Docker/CI compilation, and the shrinking authored
JavaScript inventory gate. It must not convert business logic.
