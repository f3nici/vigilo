# 02. Architecture

## 1. Shape

```
                     ┌──────────────────────────────┐
                     │  Vue 3 + TS SPA (one build)  │
                     │  + service worker + manifest │
                     └───────┬──────────────┬───────┘
                             │              │
                      installed PWA   wrapped by Capacitor
                        (v1, phase 5)   (final phase)
                             │              │
                     ┌───────▼──────────┐ ┌─▼────────────────────┐
                     │ Browser / home-  │ │  Android / iOS app   │
                     │ screen app       │ │                      │
                     │ SQLite-WASM+OPFS │ │  native SQLite       │
                     │ outbox, Web Push │ │  outbox, FCM/APNs    │
                     └───────┬──────────┘ └─┬────────────────────┘
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

One SPA codebase serves all of it. **The PWA is v1 and ships first.** The native
Capacitor builds come last and reuse the same UI, sync engine and local schema.

Everything platform-specific sits behind three adapter interfaces in
`packages/app/src/platform`, defined in Phase 0 and implemented twice:

| Adapter | PWA implementation | Native implementation |
| --- | --- | --- |
| `Storage` | SQLite-WASM over OPFS | `@capacitor-community/sqlite` |
| `SecureStore` | WebAuthn-gated token in IndexedDB | Keychain / Android Keystore |
| `Push` | Web Push + VAPID via service worker | FCM and APNs |

Nothing else in the app knows which platform it is running on. That is what makes
the native phase a swap rather than a rewrite.

## 2. Stack and rationale

| Layer | Choice | Why |
| --- | --- | --- |
| UI | Vue 3 + TypeScript, `<script setup>` | Matches CareLane and Partforge so the owner can review it fluently. Form-heavy app, and Vue's reactivity plus v-model keeps dynamic form rendering short. |
| Build | Vite | Already the toolchain in use, first-class Capacitor support. |
| Styling | Tailwind CSS | Consistent with existing projects, fast to build accessible dense UI. |
| State | Pinia | Same as CareLane. Stores map cleanly onto sync scopes. |
| Router | Vue Router | Deep-link targets for push notifications. |
| PWA shell | Vite PWA plugin (Workbox) | Manifest, service worker, precached app shell, update prompt. The v1 delivery vehicle |
| On-device DB (PWA) | SQLite-WASM over OPFS (`@sqlite.org/sqlite-wasm`) | Real SQLite in the browser with durable origin-private file storage. Same SQL as the native build, so the local schema and every query is written once. IndexedDB alone would mean a second data layer to maintain and then throw away |
| Push (PWA) | Web Push + VAPID | One implementation covers desktop and Android, and iOS 16.4+ once installed to the home screen. Self-hosted, no Firebase dependency for v1 |
| Unlock (PWA) | WebAuthn platform authenticator | Face ID, Touch ID and Android fingerprint from the browser, with a device PIN fallback |
| Mobile shell | Capacitor, **final phase** | Already proven on this machine with carelane-android. Adds store presence, native SQLite that iOS never evicts, reliable background tasks and FCM/APNs. Wraps the same build |
| API | Node 22 + TypeScript, Express 5 | Same framework family as CareLane. Fastify would be marginally better on validation ergonomics and speed, neither matters at this scale. |
| Validation | Zod | The decisive reason for TypeScript. One schema definition validates a dynamic check form on the device while offline and again on the server. |
| DB | PostgreSQL 17 | Concurrent writes from hundreds of staff, plus reporting queries over millions of rows. SQLite would work at the low end and fall over at the high end of the stated scale. |
| ORM | Drizzle | Already in use in CareLane, SQL-shaped, good TS inference, straightforward migrations. |
| Auth | Session cookie in a plain browser tab, rotating refresh token in the installed app | See section 5. |
| PDF | PDFKit | Already used in CareLane, no headless browser dependency. |
| Jobs | node-cron in-process | Window materialisation, notification sweeps, backups, retention. At this scale a queue service is over-engineering. Extract to BullMQ if job volume grows. |
| Admin CLI | npm script in the API container | Break-glass account recovery, run over `docker compose exec`. See section 9. |
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
- **IndexedDB (Dexie) for local storage instead of SQLite-WASM.** Simpler to
  start with, but it means writing and maintaining a second data layer with
  different query semantics, then discarding it when the native build arrives.
  SQLite on both sides means the local schema, migrations and queries are written
  once. The cost is roughly 1 MB of WASM, cached by the service worker after
  first load.
- **Native apps first.** Rejected because iOS has no build path today (no Mac, no
  Apple Developer account) and store review would sit between the team and a
  working product. See doc 01 §13.

### 2.3 PWA specifics

- **Service worker** (Workbox via `vite-plugin-pwa`): precache the app shell,
  network-first for API calls with no caching of clinical responses, and an
  explicit update prompt rather than a silent swap. A care worker must never have
  the UI change mid-entry.
- **Manifest:** standalone display, portrait-primary, the icon set from doc 08,
  and shortcuts to Today and Participants.
- **Storage durability:** call `navigator.storage.persist()` at install and show
  the result. On iOS, OPFS data can be evicted after roughly 7 days without the
  app being opened, which is the main structural weakness of PWA-first and is
  handled in doc 05 §8.
- **Install flow:** a first-run screen that explains why installing matters
  (offline recording, push notifications on iOS) with platform-specific
  instructions, since iOS has no `beforeinstallprompt` and needs the Share menu
  route spelled out.
- **Version skew:** the service worker sends its build hash with every request.
  The API rejects a client more than one minor version behind with an
  `update_required` error and the app force-refreshes, so an old cached bundle
  cannot write against a changed schema.

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
│   │   │   ├── cli/          break-glass admin commands
│   │   │   └── reports/      PDF and CSV generation
│   │   └── test/
│   └── app/
│       ├── src/
│       │   ├── views/        route-level screens
│       │   ├── components/   shared UI, including the dynamic form renderer
│       │   ├── stores/       Pinia
│       │   ├── db/           local SQLite schema + queries, both platforms
│       │   ├── sync/         outbox, puller, conflict handling
│       │   ├── sw/           service worker, push handler, install flow
│       │   └── platform/     Storage / SecureStore / Push adapters
│       │       ├── web/      SQLite-WASM + OPFS, WebAuthn, Web Push
│       │       └── native/   Capacitor SQLite, Keychain, FCM (final phase)
│       ├── android/          Capacitor Android project (final phase)
│       └── ios/              Capacitor iOS project (final phase)
├── docker-compose.yml
├── Dockerfile
└── CLAUDE.md
```

`packages/shared` is the important one. The window state machine, the check
completeness rules and the coverage calculation must produce identical results
on device and on server, so they live in one place and are unit tested once.

## 4. Deployment

Cloud VPS, Australian region, Docker Compose:

- `web`: nginx serving the built SPA, reverse-proxying `/api` to the API.
- `api`: Node process, runs migrations on start, then serves.
- `db`: Postgres 17 with a named volume.
- `files`: not a service, a mounted encrypted volume for attachments.

TLS terminated by Caddy or nginx with automatic certificates. Valid HTTPS is not
optional and is required from day one: a service worker will not register without
it, so there is no PWA at all over plain HTTP. Later, the CareLane experience
recorded that a server must also set `SESSION_SAMESITE=none` and CORS-allow the
`https://localhost` origin for a Capacitor app to sign in. Build that in from the
first deploy rather than discovering it during store review.

Service worker caching rules at the nginx layer: `index.html` and `sw.js` are
served `no-cache` (the Partforge stale-bundle problem), hashed assets get a long
immutable cache, and no API response is ever cached by the CDN or the proxy.

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

- **Browser tab (office use):** httpOnly, Secure, SameSite=Lax session cookie,
  CSRF double-submit token on all mutations. Same pattern as Partforge. No local
  database, no offline mode, shorter idle timeout.
- **Installed app (PWA or native):** short-lived access token (15 min) in memory
  plus a rotating refresh token in the platform secure store, released by
  WebAuthn on the PWA and by the biometric plugin on native. Refresh rotation
  detects token theft by invalidating the family on reuse.

The same browser can be either, depending on whether it is running standalone.
The app detects display mode at startup and picks the model, so a worker who
opens the site in a tab gets the office experience and one who launches the
installed icon gets the field experience.

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
service container, build the SPA, Lighthouse PWA assertion on the built output,
then build and push the Docker images to
`docker.io/<dockerhub-username>/vigilo-{api,web}`. Native release builds arrive
in the final phase as manual `workflow_dispatch` jobs.

Container projects on this box are verified by pulling and running the built
image, not by trusting a green check.

## 9. Admin CLI (break-glass)

With no email in the system, account recovery cannot happen inside the app. The
API image therefore ships a small CLI, run on the host:

```bash
docker compose exec api npm run admin -- admin:reset-password --email jo@example.org
docker compose exec api npm run admin -- admin:disable-totp --email jo@example.org
docker compose exec api npm run admin -- admin:create --email new@example.org --name "Jo Smith"
docker compose exec api npm run admin -- admin:list
docker compose exec api npm run admin -- audit:verify
```

Design constraints, all of which are testable:

- Lives in `packages/api/src/cli`, shares the same services and encryption layer
  as the HTTP API. No duplicated password hashing or token logic.
- **No network listener.** It is a process, not an endpoint. Shell access to the
  host is the security boundary.
- **Writes to the audit log on every invocation**, with actor `system:cli`, the
  OS user, the command and the target. It cannot suppress its own audit entry.
- Refuses to run if migrations are pending.
- Cannot read, decrypt or export participant data. Accounts, sessions and the
  audit chain only. An attacker who reaches it gets access, not records, and the
  audit trail shows they were there.
- One-time passwords print once to stdout and are never persisted or logged.
- Requires `--confirm` for anything destructive, and prints the target account's
  email and role before acting.

Full command list in doc 01 §10.1. This is the answer to the sole-locked-out-
admin risk, and it should be rehearsed once before production.
