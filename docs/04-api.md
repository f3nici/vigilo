# 04. API surface

REST over HTTPS, JSON, base path `/api/v1`. Requests and responses validated by
Zod schemas that live in `packages/shared`, so the client validates before
sending and the server validates again on receipt.

## 1. Conventions

- Times are ISO 8601 with offset. Clients send their own time as
  `recorded_at`, the server stamps `received_at` and treats its own clock as
  authoritative for anything that affects lateness or ordering.
- Mutations from the native app carry `Idempotency-Key` (the record's UUID v7).
  Replaying a request returns the original result rather than creating a
  duplicate. This is what makes the outbox safe to retry.
- Pagination is cursor-based: `?limit=100&cursor=<opaque>`, response carries
  `nextCursor`. No offset pagination anywhere.
- Errors:

```json
{ "error": { "code": "scope_denied",
             "message": "You are not assigned to this participant.",
             "details": {} } }
```

  Codes: `unauthenticated`, `totp_required`, `password_change_required`,
  `scope_denied`, `not_found`, `validation_failed`, `conflict`,
  `template_version_mismatch`, `rate_limited`, `update_required`,
  `server_error`.
  `update_required` is returned when a cached PWA bundle is more than one minor
  version behind the API, and the client responds by force-refreshing.
  Messages are safe to show a user and never leak whether a participant exists.

- Every response includes `X-Server-Time` so devices can measure clock skew.

## 2. Auth

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/login` | email + password, plus `deviceId` and `platform` for native. Returns `totp_required` if enrolled |
| POST | `/auth/totp` | completes a login challenge |
| POST | `/auth/recovery-code` | single-use recovery code path |
| POST | `/auth/password` | change own password, required when `must_change_password` |
| POST | `/auth/refresh` | native only, rotates the refresh token, revokes the family on reuse |
| POST | `/auth/logout` | revokes the session or token family, marks the device for local wipe |
| GET | `/auth/me` | principal, role, scope summary, org settings the client needs |
| POST | `/auth/totp/enrol` | returns the provisioning URI and recovery codes once |

Rate limits: 10 login attempts per account per 15 minutes, 30 per IP.

## 3. Participants

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/participants` | scoped list. Workers get only assigned participants |
| POST | `/participants` | admin |
| GET | `/participants/:id` | full record including alerts, contacts, emergency plan |
| PATCH | `/participants/:id` | admin |
| POST | `/participants/:id/archive` | admin, never deletes |
| GET | `/participants/lookup?ndis=` | blind-index exact match, admin |
| GET | `/participants/:id/alerts` `POST` `PATCH` `DELETE` | admin, nurse |
| GET | `/participants/:id/contacts` `POST` `PATCH` `DELETE` | admin |
| GET | `/participants/:id/emergency-plan` `PUT` | read: all with scope. write: admin, nurse |
| GET | `/participants/:id/timeline?from=&to=` | merged windows, entries, diary, meds. The main screen's data |

Opening a participant writes `participant.view` to the audit log. Batched: one
audit row per participant per user per 15 minutes, not one per request.

## 4. Assignments

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/participants/:id/assignments` | admin, team leader in scope |
| POST | `/participants/:id/assignments` | body: `userId`, `kind`, `expiresAt`, `reason`. `temporary` requires both |
| DELETE | `/assignments/:id` | revoke, audited |
| GET | `/users/:id/assignments` | who this user can see |

Granting or revoking writes a `sync_scope_changes` row, which is how the affected
device learns to download or purge that participant.

## 5. Check templates

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/check-templates` | list with current published version |
| POST | `/check-templates` | admin, nurse |
| GET | `/check-templates/:id/versions` | history |
| POST | `/check-templates/:id/versions` | creates a draft from the current version |
| PATCH | `/check-template-versions/:id` | draft only. Published versions reject with `conflict` |
| POST | `/check-template-versions/:id/publish` | validates the schema, supersedes the previous version |
| GET | `/check-template-versions/:id` | the frozen schema, needed to render historical entries |
| GET | `/check-templates/export` | admin, nurse. Every active form, or `?ids=a,b,c`, as a portable document (D91) |
| POST | `/check-templates/import` | admin, nurse. Creates one unpublished draft per form in the document. All or nothing |

Publish validation: keys unique and immutable across versions, at least one
field, options non-empty for choice types, units present for numbers, no
range/threshold keys present (rejected outright, since ranges are out of scope).

## 6. Schedules and coverage

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/participants/:id/schedules` | admin, team leader in scope. A schedule is created with its segments in one request |
| GET | `/schedules/:id` | schedule with its segments |
| PATCH/DELETE | `/schedules/:id` | |
| PUT | `/schedules/:id/segments` | replaces the whole segment set atomically, so overlap validation runs against the final state rather than intermediate ones |
| POST | `/schedules/:id/preview` | **Does not save.** Body is a candidate segment set, response is the windows it would produce for a given date, plus warnings for overlaps, gaps, uneven division, and any existing window holding an entry that the change would orphan |
| GET/PUT | `/participants/:id/coverage-pattern` | whole weekly pattern replaced atomically |
| GET/POST | `/participants/:id/coverage-exceptions` | |
| PATCH/DELETE | `/coverage-exceptions/:id` | |
| POST | `/participants/:id/coverage/recalculate` | admin. Body: date range and whether to include the past. Returns a preview count before applying |

Recalculation preview matters. Changing a coverage pattern can turn hundreds of
missed windows into not-expected ones and rewrite compliance history, so it must
show what it will change before it changes it, and it is heavily audited.

`POST /schedules/:id/preview` response:

```json
{
  "date": "2026-07-27",
  "windows": [
    { "startsAt": "2026-07-27T07:00:00+10:00", "endsAt": "…T09:00:00+10:00", "expected": true },
    { "startsAt": "…T09:00:00+10:00", "endsAt": "…T11:00:00+10:00", "expected": true }
  ],
  "warnings": [
    { "code": "uneven_division", "message": "21:00 to 07:00 with a 240 minute window leaves a 120 minute final window." },
    { "code": "entries_affected", "count": 0 }
  ]
}
```

Segment changes regenerate future windows only. A window that already holds an
entry is never destroyed, and `entries_affected` in the preview reports any that
would be orphaned so the admin sees it before saving.

## 7. Windows and entries

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/participants/:id/windows?from=&to=` | includes status, entry summary, miss reason |
| GET | `/windows/:id` | window plus template version schema plus current entry |
| PUT | `/windows/:id/entry` | upsert by client-supplied entry id. Partial payloads allowed, only the supplied fields are written |
| PATCH | `/check-entries/:id` | edit after submission, writes revisions |
| GET | `/check-entries/:id/revisions` | edit history |
| PUT | `/windows/:id/miss-reason` | reason code plus optional note |
| GET | `/me/windows/due?within=` | every window across the user's assigned participants closing soon. Drives the home screen |

`PUT /windows/:id/entry` request:

```json
{
  "entryId": "0192f3c1-7a2b-7000-8000-1f2e3d4c5b6a",
  "templateVersionId": "…",
  "recordedAt": "2026-07-26T09:14:22+10:00",
  "values": [
    { "fieldKey": "urine_output", "number": 350, "recordedAt": "…" },
    { "fieldKey": "vent_mode", "json": "bipap", "recordedAt": "…" },
    { "fieldKey": "cares", "json": ["repositioned"], "recordedAt": "…" },
    { "fieldKey": "comment", "text": "Settled, no distress.", "recordedAt": "…" }
  ]
}
```

Response returns the resolved entry with its computed `status`, `isLate`,
`lateByMinutes` and the window's new status.

`template_version_mismatch` is returned when a device submits against a
superseded version. The device keeps its data, downloads the new version, and
presents the values for the worker to confirm. It never silently discards and
never silently remaps.

## 8. Diary

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/participants/:id/diary?from=&to=&category=&cursor=` | |
| POST | `/participants/:id/diary` | client-supplied id, idempotent |
| PATCH | `/diary-entries/:id` | body, category or visibility. Writes a revision |
| DELETE | `/diary-entries/:id` | admin only, soft delete, audited |
| GET | `/diary-entries/:id/revisions` | |
| GET/POST/PATCH | `/diary-categories` | admin |

## 9. Attachments

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/attachments` | metadata first, returns an upload URL or accepts multipart directly |
| PUT | `/attachments/:id/content` | the bytes. Resumable, so a dropout mid-upload on mobile data does not restart |
| GET | `/attachments/:id` | streamed through the API with a scope check, never served statically |
| GET | `/attachments/:id/thumb` | generated on first request, cached |
| DELETE | `/attachments/:id` | soft delete |

Server-side: MIME sniffing (do not trust the declared type), EXIF stripped from
images including GPS, size limit enforced, virus scanning if a scanner is
available.

## 10. Clinical modules

| Method | Path |
| --- | --- |
| GET/POST | `/participants/:id/care-plans`, `/care-plans/:id/versions`, `POST /care-plan-versions/:id/publish`, `POST /care-plan-versions/:id/read` |
| GET/POST/PATCH | `/participants/:id/medications`, `/medications/:id/schedules` |
| GET | `/participants/:id/medication-doses?from=&to=` |
| PUT | `/medication-doses/:id/administration` |
| POST | `/participants/:id/medication-administrations` (PRN) |

A sign-off carries `amountGiven`: free text for what actually went in, when
that differs from the charted dose (D92). Optional, and never inferred from a
blank. It is refused on a status that says nothing was given.
| GET/POST/PATCH | `/participants/:id/incidents`, `/incidents/:id`, `/incidents/:id/actions` |
| POST | `/incidents/:id/close` |
| GET | `/incidents/:id/pdf` |

## 11. Reports

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/reports/daily?participantId=&date=` | JSON for on-screen |
| GET | `/reports/daily.pdf?participantId=&from=&to=` | streamed PDF |
| GET | `/reports/trends?participantId=&fieldKey=&from=&to=&bucket=` | numeric series with real gaps preserved |
| GET | `/reports/compliance?from=&to=&participantId=&userId=` | expected, complete, late, missed with and without reason, plus not-expected shown separately |
| GET | `/exports/checks.csv?from=&to=&participantId=` | one row per entry, one column per field key |
| GET | `/exports/diary.csv`, `/exports/medications.csv` | |

Every export writes an audit row recording the requester, filters and row count.
Exports are rate-limited and, over a size threshold, generated as a background
job the user collects.

### 11.1 Participant self-access

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/me/day?date=` | one day of their own record, defaulting to today in the org timezone |
| GET | `/me/records?from=&to=` | the same, over a range, up to 31 days |
| GET | `/me/reports/daily.pdf?from=&to=` | streamed PDF, the artefact doc 07 §5 names |

**No participant id in any of them.** It comes off the principal, so there is
nothing in a path or a query string for a scope check to get wrong. The
schemas are strict, so a supplied `participantId` is a 422 rather than
something the service has to remember to ignore.

These three paths and `/auth/*` are the entire API surface a self-access
account may reach. Everything else answers `scope_denied`, enforced by one
allow-list above every router rather than by a guard on each route (D70).
Sync refuses the role as well: the feed is scoped by participant and not by
field, so a participant device would pull whole rows including diary entries
marked not visible (D73).

Every read is audited, because a view of a record is a view (doc 07 §4) and
because the audit row is the evidence that the right of access was served.

## 12. Admin

| Method | Path |
| --- | --- |
| GET/POST/PATCH | `/users` |
| POST | `/users/:id/reset-password` (returns a one-time password for the admin to hand over), `/users/:id/suspend`, `/users/:id/reactivate` |
| GET | `/users/:id/devices`, `DELETE /devices/:id` (revokes and wipes) |
| GET/PUT | `/settings` |
| GET/POST/PATCH | `/missed-reason-codes` |
| GET | `/audit-log?actor=&participant=&action=&from=&to=&cursor=` |
| GET | `/audit-log/verify` (hash chain check) |
| GET | `/jobs/runs` |

## 13. Sync

The three endpoints the mobile app depends on. Full behaviour in doc 05.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/sync/bootstrap` | full scoped snapshot for a new device or after a scope change. Returns the starting `revision` |
| GET | `/sync/changes?since=<revision>&limit=` | everything in scope changed after that revision, in revision order, plus tombstones and scope changes. Returns `nextRevision` and `hasMore` |
| POST | `/sync/push` | batch of outbox operations, each with its own id. Returns a per-operation result so a single bad operation does not block the queue |

`POST /sync/push` response:

```json
{
  "results": [
    { "opId": "…", "status": "applied", "revision": 84213 },
    { "opId": "…", "status": "duplicate", "revision": 84102 },
    { "opId": "…", "status": "rejected", "error": { "code": "template_version_mismatch" } },
    { "opId": "…", "status": "conflict", "server": { } }
  ],
  "serverRevision": 84213
}
```

## 14. Push subscriptions

Web Push in v1, FCM and APNs in the native phase, same endpoints either way.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/push/vapid-key` | public VAPID key for the service worker to subscribe with |
| POST | `/push/subscriptions` | stores the subscription against the device record |
| DELETE | `/push/subscriptions/:id` | on sign-out or unsubscribe |
| GET/PUT | `/me/notification-preferences` | per-kind toggles |

Payloads carry an initial and surname at most, never clinical content, and always
a deep link. A 410 from the push service marks the subscription dead and prunes
it.

## 15. Health

`GET /health` liveness, `GET /ready` checks DB and migration state. Neither
requires auth, neither leaks version details publicly beyond a build hash.

## 16. Not exposed over HTTP

Break-glass account recovery is deliberately **not** an API. No endpoint creates
an admin, resets a password without authentication, or clears TOTP. That work
happens through the CLI in the API container, run over `docker compose exec` by
someone with shell access to the host. See doc 01 §10.1 and doc 02 §9.
