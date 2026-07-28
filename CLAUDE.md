# Vigilo: instructions for Claude Code

Care records platform for a disability support team. Participant diaries and
admin-defined observation checks, working offline. Ships as an installable PWA
first, with native Android and iOS builds as the final phases.

**Status: Phases 0 to 5 done. This is the v1 line.** Monorepo, Docker Compose
and CI; identity, roles, TOTP, the break-glass CLI, the scope resolver, the
audit log and the encryption layer; participant records with alerts, emergency
contacts, emergency plans and assignments; check templates with versions and the
field builder, per-participant schedules and segments, coverage, the
materialiser and closer jobs, and entry recording with partial, late and
edit-with-revision; the diary with categories, occurred-at, per-entry
visibility, edit revisions and admin soft delete, encrypted attachments with
EXIF stripping and thumbnails, and the participant timeline; and the installable
PWA with a local SQLite database over OPFS, WebAuthn or PIN unlock, the
revision-cursor sync, the idempotent outbox, the attachment queue and Web Push.
**Phase 6 (reports) is next**, in `docs/09-roadmap.md`. Everything after the v1
line is additive.

## Read before building

1. `docs/01-product-requirements.md`: what it does and the rules
2. `docs/02-architecture.md`: stack and why
3. `docs/03-data-model.md`: schema
4. `docs/05-offline-sync.md`: before touching anything sync-related
5. `docs/10-decisions-and-open-questions.md`: what is locked and what is not

`docs/10` is the authority on decisions. If something here contradicts it, doc 10
wins.

## Hard rules

- **No normal ranges, thresholds or clinical alerting.** Ever. Vigilo records
  values, it does not judge them. Reject any schema field or UI treatment that
  implies a value is good or bad. Colour signals record state only.
- **Scope enforcement is centralised.** One resolver maps a principal to the
  participant ids they may touch. Route handlers never assemble access rules
  themselves.
- **Nothing is hard-deleted** while retention applies. Soft delete or archive.
- **The audit log is append-only** and hash-chained. The app database role has no
  UPDATE or DELETE on it. Views are logged, not only writes.
- **Windows are generated server-side only.** Devices never create them. The
  grid is fixed and admin-configured (anchor time, window length, segments per
  time of day). It never rolls forward from the last recorded check.
- **Nothing outside `packages/app/src/platform` may reference OPFS, WebAuthn,
  Web Push or Capacitor directly.** That rule is what makes the native phases an
  adapter swap rather than a rewrite. Worth a lint rule.
- **Break-glass account recovery is a CLI, never an HTTP endpoint.** It audits
  every invocation and cannot read participant data.
- **Sync operations are idempotent by client-supplied UUID v7.** Replay must
  never duplicate a clinical record.
- **Shared logic lives in `packages/shared`.** Window state, coverage resolution
  and completeness rules are used by both the API and the device. If the two can
  disagree, it is a bug.
- **No email.** No password reset emails, no digests, no invites. Admins issue
  credentials directly.
- **Nothing sensitive in push payloads.** An initial and surname is the ceiling.
- Australian English in all user-facing strings.

## Workflow

Per the global instructions on this machine:

- Never commit to main. Branch per phase with a descriptive name.
- Tests with the feature, not after.
- Commit, push, `gh pr create`, then `gh run watch` until CI is green.
- Verify web changes in a real browser via the Playwright MCP, and read the
  console before calling it done.
- Verify container changes by pulling and running the built image from Docker
  Hub, not by trusting a green check.
- No em dashes in prose. Comments and commit messages short and factual.

## Layout

```
packages/shared   types, Zod schemas, window/coverage/completeness logic. No I/O.
packages/api      Express 5 + Drizzle + Postgres. routes / services / db / crypto / jobs / sync / cli / reports
packages/app      Vue 3 SPA + service worker. views / components / stores / db / sync / sw / platform
                  platform/web  = SQLite-WASM + OPFS, WebAuthn, Web Push  (v1)
                  platform/native = Capacitor SQLite, Keychain, FCM       (final phases)
                  android/ and ios/ appear in the final phases
```

## Stack

Vue 3 + TypeScript + Vite + Tailwind + Pinia, as an installable PWA
(vite-plugin-pwa / Workbox), later wrapped by Capacitor.
Node 22 + TypeScript + Express 5 + Zod + Drizzle + PostgreSQL 17.
On-device SQLite: SQLite-WASM over OPFS now, Capacitor SQLite later.
Web Push + VAPID now, FCM and APNs later.
PDFKit for reports. node-cron for jobs.
Vitest for unit and API tests, Playwright for E2E.

## Verifying

```bash
cp .env.example .env
docker compose up --build          # app on :8081, API under /api
curl localhost:8081/api/ready      # database and migration state
npm test                           # all three workspaces, needs a Postgres
```

Port 8081, not 8080: Partforge already holds 8080 on this box.

The API tests need Postgres on `TEST_DATABASE_URL` (default
`postgres://vigilo:vigilo@localhost:5432/vigilo_test`). CI provides one as a
service container.

## Watch out for

- **Valid HTTPS from day one.** A service worker will not register without it,
  so there is no PWA at all over plain HTTP.
- `index.html` and `sw.js` must be served `no-cache`. Partforge hit the stale
  bundle problem, and with a service worker in play it is worse.
- **iOS can evict OPFS storage after ~7 days unused**, taking any unsent outbox
  with it. Sync aggressively, request persistent storage at install, and show
  outbox depth. Doc 05 §8.1.
- iOS has no `beforeinstallprompt` and no Background Sync. Install is a
  Share-menu instruction, and foreground sync is the primary path everywhere.
- Later, Capacitor apps sign in from origin `https://localhost`. The server must
  CORS-allow it and set `SESSION_SAMESITE=none`, or native sign-in fails
  silently. This cost time on CareLane, do not repeat it.
- Publishing a check template version is irreversible. Existing entries stay
  bound to the version they were recorded against.
- **The attachment volume must be writable by the `node` user.** The image
  creates `/data/attachments` owned by it so a fresh named volume inherits
  that, and the API refuses to start if it cannot write there. A root-owned
  mount reads fine and fails only on the first photo somebody attaches.
- **HEIC is refused** (D41). The app converts to JPEG in the browser first, so
  an iPhone never hits it, but anything bypassing the app will.
- **One tab owns the local database** (D47). The `opfs-sahpool` VFS takes
  exclusive access handles, so a Web Lock elects an owner and a second tab is
  told it is the second tab. Do not swap to the SharedArrayBuffer VFS without
  understanding that it means cross-origin isolation forever.
- **The device never reports being offline as an error** (doc 06 §7). A network
  failure that is not an `ApiRequestError` means no signal, and the app carries
  on with what it holds. Throwing from the session refresh gives a worker in a
  house with no reception a blank screen, which is the failure Phase 5 exists to
  prevent, and it has already happened once.
- **A local write goes through the outbox and updates the local row in the same
  transaction**, never straight to the API. `packages/app/src/lib/records.ts` is
  the only place screens read or write records.
- **`sync_applied_ops` is append-only.** It is the idempotency ledger: an UPDATE
  would let a replay be re-applied and a DELETE would let one land twice.
- Inter is self-hosted in `packages/app/public/fonts` and precached by the
  service worker, so an installed app offline renders in the same typeface as
  one online. Regenerate icons and splash screens with
  `node packages/app/scripts/generate-icons.mjs`.
- Coverage recalculation can rewrite compliance history. It must preview before
  applying, and it is heavily audited.
- Never point a store review build at production data. Use staging with seeded
  fake participants.
