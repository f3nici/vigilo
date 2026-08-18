# Vigilo: instructions for Claude Code

Care records platform for a disability support team. Participant diaries and
admin-defined observation checks, working offline. Ships as an installable PWA
first, with native Android and iOS builds as the final phases.

**Status: Phases 0 to 9 done, plus a round of pre-hardening fixes and the
open issues.** Phase 5 was the v1 line and everything since is
additive. Monorepo, Docker Compose and CI; identity, roles, TOTP, the
break-glass CLI, the scope resolver, the audit log and the encryption layer;
participant records with alerts, emergency contacts, emergency plans and
assignments; check templates with versions and the field builder,
per-participant schedules and segments, coverage, the materialiser and closer
jobs, and entry recording with partial, late and edit-with-revision; the diary
with categories, occurred-at, per-entry visibility, edit revisions and admin
soft delete, encrypted attachments with EXIF stripping and thumbnails, and the
participant timeline; the installable PWA with a local SQLite database over
OPFS, WebAuthn or PIN unlock, the revision-cursor sync, the idempotent outbox,
the attachment queue and Web Push; reports: the daily PDF, trends with gaps
preserved, the compliance report and audited CSV exports; and the medication
administration record with materialised doses on the same coverage rules,
sign-off with notes and witnesses, PRN recording and offline sign-off through
the existing outbox; and care plans with versions, publishing, read receipts
and unread markers, plus incidents with the full field set, the status
workflow, follow-up actions and a PDF; and participant self-access: my day, my
records and my reports, served by purpose-built DTOs behind an allow-list that
refuses the rest of the API to that role.
**Phase 10 (production hardening) is next**, in `docs/09-roadmap.md`. It must
complete before any real participant record is entered.

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
- **A check entry may have no window** (D89). `check_entries.window_id` is
  nullable for a check somebody recorded on demand, the same shape PRN
  medication uses. No window means no lateness and no status, and it is
  **outside the compliance percentage in both directions**, counted beside it.
  It has its own array on the daily report so it can never reach
  `countCompliance`.
- **A check form is offered only for the participants it was ticked for**
  (D94). `participant_check_forms` is the tick list, and a form on the
  participant's active schedule counts as ticked without a row and cannot be
  turned off. This is **not a permission**: it decides what the on-demand
  picker offers and nothing else, so never reach for it to answer "may this
  person see that".
- **A note on a recorded check sits beside it, never in it** (D96).
  `check_entry_notes` is append-only, enforced by a grant, and encrypted.
  Adding one writes no revision and does not touch `edit_count`, because a note
  explains a record and does not alter one. An admin writes, every staff role
  reads, and it never reaches a participant's own record.
- **Ending a schedule removes every window still open, the one in progress
  included** (D97). That is `removeOpenWindows`, deliberately not
  `regenerateFutureWindows`, which preserves the open window because a segment
  change should not interrupt a worker mid-check. A window holding an entry is
  kept either way: deleting it would cascade the values away.
- **The diary is the day book, not a notes app** (D95). An entry may be dated
  up to 730 days ahead, because writing down what somebody has coming up is
  what it is for; notes on how something went live in the team's separate
  product. `recordedAt` still says when it was written, so a future date never
  disguises that. The tab opens on a month grid and the selected day. The old
  rule refusing anything in the future is gone, and `OCCURRED_AT_SKEW_MINUTES`
  with it.
- **A passkey signs somebody in; a PIN or a fingerprint only releases what the
  device already holds** (D99). Two different mechanisms behind one screen, and
  the difference is the whole design. `webauthn_credentials` is a real
  credential verified against the server and it counts as the second factor,
  because the ceremony only completes after the device verified the person.
  `device_credentials` is a secret issued to a session that already existed,
  sealed in the secure store, and it is **not a factor**: it expires unused, a
  wrong secret retires it outright, and a password change or a sign-out kills
  it. Biometric quick sign-in is offered only on an installed app on a
  handheld, the PIN wherever it is not. The password never goes away, because
  with no email an account whose only credential is on a lost phone is one
  nobody can hand back.
- **There are no notifications** (D88). The job, the routes, the VAPID config,
  the web-push dependency and the app's push adapter are gone, because with no
  roster there was no way to tell a worker on shift from one asleep. The
  service worker's `push` and `notificationclick` handlers stay on purpose, and
  so do the three tables. Do not add a sender without a roster to aim it with.
- **Doses are generated server-side only, like windows,** and never for a time
  that has already passed (D59). A missed dose says a person did not get their
  medication, so one invented for a time before the chart existed blames staff
  for a dose nobody was asked for.
- **Windows are generated server-side only.** Devices never create them. The
  grid is fixed and admin-configured (anchor time, window length, segments per
  time of day). It never rolls forward from the last recorded check, and
  **never lays a window that has already closed** (D85, the same rule as D59
  for doses). A test that needs a historical window passes `now` to
  `materialiseParticipant` and says when it is pretending to be.
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
- **A validation failure never reaches a user in Zod's words** (#23).
  `describeIssue` in `packages/shared/src/validation.ts` turns one into plain
  English and is what the API's error middleware and the two client-side forms
  both call. A message an author wrote by hand is left exactly as it is.
- Australian English in all user-facing strings.
- **Source-available, not open source** (D98). PolyForm Noncommercial 1.0.0,
  copyright Fenici. Noncommercial use is free; commercial use needs written
  permission, granted case by case to a named entity. Do not relicense, do not
  add an SPDX header claiming anything else, and do not add a dependency whose
  licence would conflict with distributing this under those terms.

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
                  platform/web  = SQLite-WASM + OPFS, WebAuthn (unlock and passkeys)  (v1)
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
  bound to the version they were recorded against. **An imported check form
  always lands as a new, unpublished draft** (D91): the export carries the name,
  the description and the field set and no identity at all, so an import can
  never update, supersede or publish over a version that entries point at.
- **The attachment volume must be writable by the `node` user.** The image
  creates `/data/attachments` owned by it so a fresh named volume inherits
  that, and the API refuses to start if it cannot write there. A root-owned
  mount reads fine and fails only on the first photo somebody attaches.
- **A medication sign-off is never deleted.** The app database role has no
  DELETE on `medication_administrations`, enforced by a grant, and there is no
  route that would use one.
- **Rich text is source text, never HTML** (D63). The renderer lives in
  `packages/shared/src/richtext.ts` and is used by care plans and by the
  guidance blocks on a check form. It escapes everything before emitting a tag,
  the only tags it can emit are in `ALLOWED_TAGS`, both sides call it, and
  DOMPurify runs over its output in `RichText.vue`, the one component in the app
  that calls `v-html`. Nothing anywhere stores or trusts HTML.
- **A primary button is never greyed out for missing input** (D78). Use
  `useFormGuard` in `packages/app/src/lib/forms.ts`: the button stays live,
  pressing it names what is missing and focuses the field. Only `busy` disables
  a button. A new form that reaches for `:disabled="!canSave"` is the bug this
  replaced.
- **A check form field can record nothing.** An `info` field is guidance and is
  typed `required: false` so it can never hold a check open (D81). Anything
  asking "does this field hold an answer" goes through `fieldRecordsValue`
  rather than testing the type inline.
- **Incidents never reach a device** (D67) and are never visible to a
  participant account, refused in the service rather than hidden in the UI.
- **The org timezone comes from `ORG_TIMEZONE`** (default `Australia/Perth`)
  and is applied only while `updated_at = created_at` on the settings row
  (D84). The app reads `session.timeZone` and nothing hardcodes a zone: there
  were fifteen `'Australia/Melbourne'` fallbacks and they were fifteen chances
  to disagree with the server about what day it is. The API test harness sets
  `TEST_TIME_ZONE` explicitly, so the suite does not quietly change meaning
  when the product default moves.
- **A self-access account reaches `/auth` and three `/me` paths and nothing
  else** (D70). The allow-list is `SELF_ACCESS_ALLOWED` in
  `packages/api/src/middleware/principal.ts`, applied once above every router,
  so a route added in a later phase is refused for that role by default. A
  participant is in scope for their own record, so `assertInScope` passes for
  them everywhere and cannot be what stops this.
- **Self-access DTOs are built field by field, never filtered from a staff
  one** (D71), and a participant never sees a missed or pending check (D72).
- **A self-access account does not sync and holds nothing on a device** (D73).
  The feed is scoped by participant, not by field, so a pull would carry the
  diary entries staff marked not visible. Those three screens are the one place
  in the product where being offline means nothing loads, and they say so.
- **Medication has no clinical checking and never will.** No interactions, no
  maximum daily totals, no dose validation. A dose is text transcribed off a
  label, and software that does arithmetic on doses is software that can get a
  dose wrong. That covers `amount_given` on a sign-off, which is what actually
  went in and is free text for the same reason (D92). It is optional, a blank
  never means "the charted amount", and it cannot sit on a status that says
  nothing was given.
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
- **The compliance counting lives in `packages/shared/reports.ts`**, not in a
  SQL query. It is the one number somebody will be asked to defend, so the PDF,
  the screen and the API all derive it from the same function. `not_expected`
  is never in the denominator (D51 covers the empty case).
- **A CSV field starting `=`, `+`, `-` or `@` is prefixed with an apostrophe**
  (D54). A spreadsheet runs those as formulas and this file goes to outsiders.
- **The trend chart is hand-drawn SVG on purpose** (D52). Every charting
  library interpolates across missing data, and doc 01 §8.2 requires a gap be
  drawn as a gap.
- **A built CSV export is decrypted participant data on the attachment volume.**
  It is deleted after 24 hours by a job, and every export and download is
  audited with its filters and row count.
- Never point a store review build at production data. Use staging with seeded
  fake participants.
