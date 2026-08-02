# 09. Build roadmap

Phased, core first. Each phase ends in something demonstrable and merged. Follow
the machine conventions: branch per phase, tests, PR with `gh pr create`, watch
CI with `gh run watch` until green, and verify container images by pulling and
running them rather than trusting a green tick.

Estimates assume Claude Code doing the building with review at each phase gate.
They are sequencing guides, not commitments.

---

## Phase 0: Foundations

**Goal:** an empty but correct skeleton that deploys.

- Monorepo with npm workspaces: `shared`, `api`, `app`.
- TypeScript strict everywhere, ESLint, Prettier.
- Docker Compose: api, web (nginx), Postgres 17.
- Drizzle set up, migrations running on API start.
- Health and ready endpoints.
- CI: typecheck, lint, test, build images, push to Docker Hub.
- Base Vue app with routing, Tailwind, and the palette from doc 08 wired as
  design tokens in both themes.
- **The three platform adapter interfaces** (`Storage`, `SecureStore`, `Push`) in
  `packages/app/src/platform`, with web implementations only. Nothing outside
  `platform/` may reference OPFS, WebAuthn or Capacitor directly.
- `CLAUDE.md` in the repo.

**Done when:** `docker compose up --build` serves an empty authenticated shell,
CI is green, and the pushed image runs.

---

## Phase 1: Identity and access

**Goal:** people can sign in and the access model is correct before any clinical
data exists.

- Users, roles, sessions, refresh tokens, devices.
- Argon2id passwords, forced change on admin-issued credentials.
- TOTP enrolment and challenge, recovery codes.
- **The break-glass admin CLI** (`admin:create`, `admin:reset-password`,
  `admin:disable-totp`, `admin:unlock`, `admin:list`, `admin:revoke-sessions`,
  `audit:verify`), audited on every invocation, with no HTTP surface and no
  access to participant data. Built here, not later, because with no email this
  is the only account recovery path that exists.
- The **central scope resolver**, and every route going through it.
- Append-only hash-chained audit log, plus the chain verification job.
- Encryption layer: envelope encryption, blind index helper, key versioning.
- Admin user management screens.

**Done when:** all five roles exist, an integration test per role proves
out-of-scope requests are denied, the audit log rejects UPDATE and DELETE from
the app role, and `docker compose exec api npm run admin -- admin:reset-password`
recovers a locked-out admin and leaves an audit row.

**Do not skip ahead of this phase.** Retrofitting scope enforcement and
encryption onto existing tables is far more expensive than building on them.

---

## Phase 2: Participants

- Participant CRUD with encrypted fields and the NDIS blind index.
- Alerts, emergency contacts, emergency plans.
- Assignments, including temporary grants with expiry and reason.
- Participant list and overview screens.
- Archive, never delete.

**Done when:** an admin creates a participant, assigns a worker, and that worker
sees exactly that participant and nothing else.

---

## Phase 3: Checks (the core)

The biggest phase and the reason the product exists.

- Check templates, versions, publish and supersede.
- The admin **field builder** with live preview and publish diff.
- **Schedules and segments**, with the admin schedule editor: per-participant
  window length, anchor time, applicable hours and weekdays, multiple segments
  for day and overnight intervals, overlap validation, and the **live window
  preview** (doc 06 §5). The grid is fixed and admin-configured, never rolling.
- Coverage patterns and exceptions, with the recalculation preview.
- Window materialiser and closer jobs.
- The window state machine in `packages/shared`, unit tested on both sides.
- Dynamic form renderer driven by the template version schema.
- Entry recording: partial, late back-fill, edit with revisions.
- Missed reason codes and capture.
- Web UI for all of it.

**Done when:** an admin defines a vent-observation template, sets a participant
to 2-hourly through the day and 4-hourly overnight with weekday-only coverage,
sees the resulting window times in the preview before saving, and a worker then
records complete, partial, late and missed windows on the web, with weekend
windows correctly showing as not expected.

---

## Phase 4: Diary

- Categories, entries, occurred-at separate from created-at.
- Attachments: upload, encryption at rest, EXIF stripping, thumbnails, streamed
  download with scope checks.
- Participant-visibility toggle.
- Edit revisions, admin soft delete.
- Timeline view merging checks and diary.

**Done when:** the participant timeline shows a day's checks and diary entries
together, with photos, and edits show as edits.

---

## Phase 5: PWA and offline sync

The riskiest phase. Budget for it. This is what puts the app in workers' hands.

- Web app manifest, icons, service worker (Workbox), install flow with the
  iOS Share-menu instructions, `navigator.storage.persist()`.
- Local database: SQLite-WASM over OPFS in a worker thread, local schema and
  migrations, column-level encryption with a WebAuthn PRF or PIN-derived key.
- WebAuthn unlock, with a device PIN fallback.
- `/sync/bootstrap`, `/sync/changes`, `/sync/push`.
- Outbox with idempotency, backoff, per-operation results.
- Scope change and tombstone handling.
- Attachment upload queue with camera capture.
- Sync status indicator with outbox depth and age.
- Background Sync where available, foreground sync everywhere as the primary
  path.
- ~~Web Push with VAPID: overdue warnings, close notifications, escalations,
  deep links.~~ **Removed before production (D88.)** With no roster there was
  no honest way to tell a worker on shift from one asleep, so everyone assigned
  was told at any hour. The service worker keeps its listeners; the sending side
  is gone until there is something to aim it with.
- Service worker update handling that never interrupts an entry in progress.
- **Every test in doc 05 §9**, including the 48-hour airplane-mode scenario and
  the PWA lifecycle tests.

**Done when:** the PWA is installed on a real Android phone and a real iPhone
(Safari 17+), records 24 windows across two days in airplane mode with a scope
revocation midway, reconnects, and every record lands exactly once with the
revoked participant's local data gone.

**This is the v1 line.** Web plus installed PWA, auth, participants, checks,
diary, offline sync. Everything after this is additive.

---

## Phase 6: Reports

- Daily participant report PDF, single day and date range.
- Trend charts for numeric fields, gaps preserved not interpolated.
- Compliance report with not-expected excluded from the denominator.
- CSV exports, audit-logged, background job over a size threshold.

**Done when:** a month of data produces all four outputs in under 10 seconds and
the compliance numbers match hand-counted windows in a seeded fixture.

---

## Phase 7: Medications (done)

- Medications, schedules, materialised doses using the same coverage rules.
- Administration sign-off: given, refused, withheld, not required,
  self-administered, with notes and optional witness.
- PRN recording.
- Offline sign-off through the existing outbox.

---

## Phase 8: Care plans and incidents (done)

- Care plans with versions, publish, read receipts, unread markers.
- Rich text sanitised on write and render.
- Incidents with the full field set, status workflow, follow-up actions, PDF.
- Incidents hidden from participant self-access, enforced in the scope layer.

---

## Phase 9: Participant self-access (done)

- Participant role screens: my day, my records, my reports.
- Visibility filtering enforced server-side.
- Simplified, high-contrast, accessible UI.

---

## Phase 10: Production hardening

Must complete before any real participant record is entered.

- Backups with encryption, retention, verification and a **tested restore**.
- Retention and archival job with no silent deletion.
- Rate limiting review, security headers, CSP tightening.
- Load test at 300 devices.
- Penetration test.
- Runbook: restore, key rotation, break-glass admin recovery (rehearsed once,
  not first attempted during a lockout), incident response.

---

## Phase 11: Native Android

The apps come last. Everything they need already exists.

- Capacitor Android project wrapping the same build.
- Native implementations of the three platform adapters: Capacitor SQLite with
  SQLCipher, Android Keystore, FCM.
- Background sync via WorkManager.
- Signing keystore, **backed up off this machine** (the CareLane keystore exists
  on one machine only, do not repeat that).
- Play Store: data safety form, health declarations, permission justifications,
  internal testing track, then production.

**Done when:** the entire doc 05 §9 test suite passes unchanged against the
native build, and the Play Store build is installed and recording checks.

---

## Phase 12: Native iOS

**Blocked. No Mac, no Apple Developer account, no signing setup. See doc 10 Q10.**

- Resolve the build path first: GitHub Actions macOS runners, a cloud Mac
  service, or buying a Mac Mini. Apple Developer Program enrolment either way.
- Capacitor iOS project, APNs, BGProcessingTask, Keychain.
- Privacy nutrition labels, demo account pointed at staging, account deletion
  answer for guideline 5.1.1(v).
- TestFlight, then App Store submission.

iOS staff have a working installed PWA with push from Phase 5, so this phase is
about store presence and storage durability, not about giving them access. That
is the point of the ordering.

---

## Suggested order of attack

Phases 0 to 5 are strictly sequential and end at the v1 line. After that, 6
(reports) usually matters most to admins, and 7 to 9 can be reordered to suit.

Phase 10 gates real data. Phases 11 and 12 are optional in the sense that the
product works without them, and worth doing for store presence, storage
durability on iOS, and reliable background sync. Phase 12 can start whenever the
Mac problem is solved.

## Standing rules

- Never commit to main. Branch per phase with a descriptive name.
- Tests written with the feature, not after the phase.
- `packages/shared` logic (windows, coverage, completeness) is tested once and
  used by both sides. If server and device can disagree, that is a bug.
- No feature ships without an audit entry where doc 07 requires one.
- Verify in a real browser via the Playwright MCP before calling a web change
  done.
- Pull and run the built container image before calling a deployment done.
- Nothing outside `packages/app/src/platform` may reference OPFS, WebAuthn,
  Web Push or Capacitor directly. That rule is what makes Phases 11 and 12 an
  adapter swap instead of a rewrite, and it is worth a lint rule.
