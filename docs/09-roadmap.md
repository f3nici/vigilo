# 09. Build roadmap

Phased, core first. Each phase ends in something demonstrable and merged. Follow
the machine conventions: branch per phase, tests, PR with `gh pr create`, watch
CI with `gh run watch` until green, and verify container images by pulling and
running them rather than trusting a green tick.

Estimates assume Claude Code doing the building with review at each phase gate.
They are sequencing guides, not commitments.

---

## Phase 0 — Foundations

**Goal:** an empty but correct skeleton that deploys.

- Monorepo with npm workspaces: `shared`, `api`, `app`.
- TypeScript strict everywhere, ESLint, Prettier.
- Docker Compose: api, web (nginx), Postgres 17.
- Drizzle set up, migrations running on API start.
- Health and ready endpoints.
- CI: typecheck, lint, test, build images, push to Docker Hub.
- Base Vue app with routing, Tailwind, and the palette from doc 08 wired as
  design tokens in both themes.
- `CLAUDE.md` in the repo.

**Done when:** `docker compose up --build` serves an empty authenticated shell,
CI is green, and the pushed image runs.

---

## Phase 1 — Identity and access

**Goal:** people can sign in and the access model is correct before any clinical
data exists.

- Users, roles, sessions, refresh tokens, devices.
- Argon2id passwords, forced change on admin-issued credentials.
- TOTP enrolment and challenge, recovery codes.
- The **central scope resolver**, and every route going through it.
- Append-only hash-chained audit log, plus the chain verification job.
- Encryption layer: envelope encryption, blind index helper, key versioning.
- Admin user management screens.
- CLI break-glass admin creation, audited.

**Done when:** all five roles exist, an integration test per role proves
out-of-scope requests are denied, and the audit log rejects UPDATE and DELETE
from the app role.

**Do not skip ahead of this phase.** Retrofitting scope enforcement and
encryption onto existing tables is far more expensive than building on them.

---

## Phase 2 — Participants

- Participant CRUD with encrypted fields and the NDIS blind index.
- Alerts, emergency contacts, emergency plans.
- Assignments, including temporary grants with expiry and reason.
- Participant list and overview screens.
- Archive, never delete.

**Done when:** an admin creates a participant, assigns a worker, and that worker
sees exactly that participant and nothing else.

---

## Phase 3 — Checks (the core)

The biggest phase and the reason the product exists.

- Check templates, versions, publish and supersede.
- The admin **field builder** with live preview and publish diff.
- Schedules with per-participant window length and anchor time.
- Coverage patterns and exceptions, with the recalculation preview.
- Window materialiser and closer jobs.
- The window state machine in `packages/shared`, unit tested on both sides.
- Dynamic form renderer driven by the template version schema.
- Entry recording: partial, late back-fill, edit with revisions.
- Missed reason codes and capture.
- Web UI for all of it.

**Done when:** an admin defines a vent-observation template, sets a participant
to 2-hourly with weekday-only coverage, and a worker records complete, partial,
late and missed windows on the web, with weekend windows correctly showing as
not expected.

---

## Phase 4 — Diary

- Categories, entries, occurred-at separate from created-at.
- Attachments: upload, encryption at rest, EXIF stripping, thumbnails, streamed
  download with scope checks.
- Participant-visibility toggle.
- Edit revisions, admin soft delete.
- Timeline view merging checks and diary.

**Done when:** the participant timeline shows a day's checks and diary entries
together, with photos, and edits show as edits.

---

## Phase 5 — Mobile and offline sync

The riskiest phase. Budget for it.

- Capacitor Android project, secure storage, biometric unlock.
- Local SQLCipher SQLite schema.
- `/sync/bootstrap`, `/sync/changes`, `/sync/push`.
- Outbox with idempotency, backoff, per-operation results.
- Scope change and tombstone handling.
- Attachment upload queue.
- Sync status indicator.
- Background sync (WorkManager, BGProcessingTask).
- FCM push, overdue and escalation notifications, deep links.
- **Every test in doc 05 §9**, including the 48-hour airplane-mode scenario.

**Done when:** an Android device records 24 windows across two days in airplane
mode with a scope revocation midway, reconnects, and every record lands exactly
once with the revoked participant's local data gone.

**This is the v1 line.** Web plus Android, auth, participants, checks, diary,
offline. Everything after this is additive.

---

## Phase 6 — Reports

- Daily participant report PDF, single day and date range.
- Trend charts for numeric fields, gaps preserved not interpolated.
- Compliance report with not-expected excluded from the denominator.
- CSV exports, audit-logged, background job over a size threshold.

**Done when:** a month of data produces all four outputs in under 10 seconds and
the compliance numbers match hand-counted windows in a seeded fixture.

---

## Phase 7 — Medications

- Medications, schedules, materialised doses using the same coverage rules.
- Administration sign-off: given, refused, withheld, not required,
  self-administered, with notes and optional witness.
- PRN recording.
- Offline sign-off through the existing outbox.

---

## Phase 8 — Care plans and incidents

- Care plans with versions, publish, read receipts, unread markers.
- Rich text sanitised on write and render.
- Incidents with the full field set, status workflow, follow-up actions, PDF.
- Incidents hidden from participant self-access, enforced in the scope layer.

---

## Phase 9 — Participant self-access

- Participant role screens: my day, my records, my reports.
- Visibility filtering enforced server-side.
- Simplified, high-contrast, accessible UI.

---

## Phase 10 — iOS

**Blocked on a Mac or CI signing setup. See doc 10.**

- Capacitor iOS project, APNs, background tasks, Keychain.
- Apple Developer Program enrolment.
- Build and signing, whether local or via GitHub Actions macOS runners.
- Privacy nutrition labels, demo account on staging, account deletion answer.
- TestFlight, then App Store submission.

---

## Phase 11 — Production hardening

- Backups with encryption, retention, verification and a **tested restore**.
- Retention and archival job with no silent deletion.
- Rate limiting review, security headers, CSP tightening.
- Load test at 300 devices.
- Penetration test before real participant data goes in.
- Runbook: restore, key rotation, break-glass admin, incident response.
- Play Store release with data safety declarations.

---

## Suggested order of attack

Phases 0 to 5 are strictly sequential. After the v1 line, 6 (reports) usually
matters most to admins, and 7 to 9 can be reordered to suit. Phase 10 can start
any time the Mac problem is solved. Phase 11 must complete before any real
participant record is entered.

## Standing rules

- Never commit to main. Branch per phase with a descriptive name.
- Tests written with the feature, not after the phase.
- `packages/shared` logic (windows, coverage, completeness) is tested once and
  used by both sides. If server and device can disagree, that is a bug.
- No feature ships without an audit entry where doc 07 requires one.
- Verify in a real browser via the Playwright MCP before calling a web change
  done.
- Pull and run the built container image before calling a deployment done.
