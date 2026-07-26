# 02. Architecture

## 1. Shape

```
                     ┌──────────────────────────────┐
                     │  Vue 3 + TS SPA (one build)  │
                     └───────┬──────────────┬───────┘
                             │              │
                    served as web    wrapped by Capacitor
                             │              │
                     ┌───────▼───┐   ┌──────▼───────────────┐
                     │  Browser  │   │  Android / iOS app   │
                     │           │   │  + SQLite + outbox   │
                     └───────┬───┘   └──────┬───────────────┘
                             │  HTTPS/JSON  │
                     ┌───────▼──────────────▼───────┐
                     │   Node + TypeScript API      │
                     │   Express 5, Zod, Drizzle    │
                     └───┬──────────┬───────────┬───┘
                         │          │           │
                 ┌───────▼──┐ ┌─────▼─────┐ ┌───▼──────────┐
                 │ Postgres │ │ Encrypted │ │ node-cron    │
                 │          │ │ file store│ │ jobs         │
                 └──────────┘ └───────────┘ └──────────────┘
```

One SPA codebase. The browser and the native apps run the same UI. The native
shell adds a local SQLite database, an outbox, secure token storage, biometrics,
camera and push. Code paths that differ are behind a small platform abstraction,
not duplicated screens.

## 2. Stack and rationale

| Layer | Choice | Why |
| --- | --- | --- |
| UI | Vue 3 + TypeScript, `<script setup>` | Matches CareLane and Partforge so the owner can review it fluently. Form-heavy app, and Vue's reactivity plus v-model keeps dynamic form rendering short. |
| Build | Vite | Already the toolchain in use, first-class Capacitor support. |
| Styling | Tailwind CSS | Consistent with existing projects, fast to build accessible dense UI. |
| State | Pinia | Same as CareLane. Stores map cleanly onto sync scopes. |
| Router | Vue Router | Deep-link targets for push notifications. |
| Mobile shell | Capacitor | Already proven on this machine with carelane-android. One UI across web and both stores. Gives native SQLite, secure storage, camera, biometrics, push and background tasks. |
| API | Node 22 + TypeScript, Express 5 | Same framework family as CareLane. Fastify would be marginally better on validation ergonomics and speed, neither matters at this scale. |
| Validation | Zod | The decisive reason for TypeScript. One schema definition validates a dynamic check form on the device while offline and again on the server. |
| DB | PostgreSQL 17 | Concurrent writes from hundreds of staff, plus reporting queries over millions of rows. SQLite would work at the low end and fall over at the high end of the stated scale. |
| ORM | Drizzle | Already in use in CareLane, SQL-shaped, good TS inference, straightforward migrations. |
| On-device DB | SQLite via `@capacitor-community/sqlite` | Real durable storage on iOS, unlike IndexedDB which Safari can evict. |
| Auth | Session cookie on web, rotating refresh token on native | See section 5. |
| PDF | PDFKit | Already used in CareLane, no headless browser dependency. |
| Jobs | node-cron in-process | Window materialisation, notification sweeps, backups, retention. At this scale a queue service is over-engineering. Extract to BullMQ if job volume grows. |
| Push | Firebase Cloud Messaging + APNs | The standard path for Capacitor. FCM can relay to APNs, but going direct to APNs avoids sending payloads through Google. |
| Container | Docker Compose | Matches every other project on this box. |
| Tests | Vitest (unit, API) + Playwright (E2E) | Vitest matches CareLane. Playwright MCP is available on this machine for browser verification. |

### 2.1 Why TypeScript everywhere

Checks are admin-defined at runtime. A field's type, unit and options are data,
not code, and that data flows through the device's local database, an offline
outbox, the API, and Postgres. In plain JavaScript a type mismatch surfaces as a
wrong clinical value silently saved. Zod schemas derived from the template
version definition run identically on device and server, and a mismatch fails
the build or the request rather than the shift.

### 2.2 Rejected alternatives

- **React / React Native.** Would keep a native-rewrite escape hatch open, at the
  cost of stack consistency with the owner's other projects. Capacitor is already
  proven here, so the hatch is worth little.
- **PowerSync / ElectricSQL / RxDB.** Solve general bidirectional sync with
  arbitrary conflicts. Vigilo's data is append-mostly with rare edits and no
  concurrent multi-writer documents, so a purpose-built outbox is smaller,
  self-hosted, dependency-free and easier to debug. See doc 05.
- **SQLite on the server.** Fine at 20 participants, wrong at 200 with 300 staff.
- **Nuxt / SSR.** No SEO requirement, all screens are behind auth, and SSR
  complicates the Capacitor build. Plain SPA.

## 3. Repository layout

Monorepo, npm workspaces, matching CareLane's `packages/` convention.

```
vigilo/
├── docs/                     these documents
├── packages/
│   ├── shared/               types, Zod schemas, check-form engine, date/window
│   │                         maths. Imported by both api and app. No I/O.
│   ├── api/
│   │   ├── src/
│   │   │   ├── routes/       one module per resource
│   │   │   ├── services/     business logic, no express types
│   │   │   ├── db/           drizzle schema + migrations
│   │   │   ├── crypto/       field encryption, blind index, hash chain
│   │   │   ├── jobs/         cron jobs
│   │   │   ├── sync/         push and pull handlers
│   │   │   └── reports/      PDF and CSV generation
│   │   └── test/
│   └── app/
│       ├── src/
│       │   ├── views/        route-level screens
│       │   ├── components/   shared UI, including the dynamic form renderer
│       │   ├── stores/       Pinia
│       │   ├── db/           local SQLite schema + queries
│       │   ├── sync/         outbox, puller, conflict handling
│       │   └── platform/     web vs native adapters
│       ├── android/          Capacitor Android project
│       └── ios/              Capacitor iOS project (later phase)
├── docker-compose.yml
├── Dockerfile
└── CLAUDE.md
```

`packages/shared` is the important one. The window state machine, the check
completeness rules and the coverage calculation must produce identical results
on device and on server, so they live in one place and are unit tested once.

## 4. Deployment

Cloud VPS, Australian region, Docker Compose:

- `web` — nginx serving the built SPA, reverse-proxying `/api` to the API.
- `api` — Node process, runs migrations on start, then serves.
- `db` — Postgres 17 with a named volume.
- `files` — not a service, a mounted encrypted volume for attachments.

TLS terminated by Caddy or nginx with automatic certificates. Valid HTTPS is not
optional: the native apps will not authenticate without it, and the CareLane
experience recorded that a server must set `SESSION_SAMESITE=none` and CORS-allow
the `https://localhost` app origin for a Capacitor app to sign in. Vigilo should
set that correctly from the first deploy rather than discovering it during store
review.

Environments:

| Env | Purpose | Data |
| --- | --- | --- |
| local | Docker Compose on the dev box | Seeded fake participants |
| staging | Same VPS, separate compose project and DB | Fake data, used for store review builds |
| production | VPS | Real |

Store reviewers need a working demo account. Point review builds at staging with
seeded fake participants, never at production.

## 5. Auth architecture

Two token models behind one API:

- **Web:** httpOnly, Secure, SameSite=Lax session cookie, CSRF double-submit
  token on all mutations. Same pattern as Partforge.
- **Native:** short-lived access token (15 min) in memory plus a rotating refresh
  token in Capacitor secure storage (Keychain / Android Keystore), released by
  biometric unlock. Refresh rotation detects token theft by invalidating the
  family on reuse.

TOTP is verified at sign-in for roles that require it, before any token is
issued. Recovery codes are single-use, hashed at rest.

Every request resolves to a `principal` (user id, role, scope) in middleware, and
every data access goes through a scope-checking layer. Access scope is never
computed in a route handler ad hoc.

## 6. Background jobs

| Job | Cadence | Does |
| --- | --- | --- |
| Window materialiser | every 15 min | Generates windows 7 days forward per active schedule, applying coverage to set `not_expected` |
| Window closer | every minute | Transitions closed windows to `missed`, respecting coverage |
| Notification sweep | every minute | Sends pre-close warnings, close notifications, escalations |
| Coverage recalculation | on demand | When a pattern or exception changes, recomputes affected future (and optionally past) windows |
| Backup | nightly | `pg_dump` plus attachment volume snapshot, encrypted, retained per policy, verified |
| Retention | weekly | Flags records past retention for archival, never deletes silently |
| Device pruning | daily | Expires stale device registrations and refresh token families |

All jobs are idempotent and safe to run twice. Each writes a job run record with
outcome so a missed cron is visible rather than silent.

## 7. Observability

- Structured JSON logs with a request id, never containing participant data.
- `/api/health` (liveness) and `/api/ready` (DB reachable, migrations current).
- Metrics worth exposing: sync push failures, outbox depth reported by devices,
  windows missed without reason, notification delivery failures, job run
  outcomes.
- Errors captured with participant identifiers redacted. If an external error
  service is ever added, it must be self-hosted, because stack traces from this
  app can carry health data.

## 8. CI/CD

Per the machine's global conventions: branch, change, test, commit, push, PR
with `gh pr create`, then watch with `gh run watch` until green.

Pipeline: typecheck, lint, unit tests, API integration tests against a Postgres
service container, build the SPA, build and push the Docker images to
`docker.io/<dockerhub-username>/vigilo-{api,web}`. Android release builds are a
manual `workflow_dispatch` job. iOS is deferred (see doc 10).

Container projects on this box are verified by pulling and running the built
image, not by trusting a green check.
