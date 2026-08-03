# 03. Data model

PostgreSQL 17, Drizzle ORM. All timestamps are `timestamptz` stored in UTC.

## Conventions

- Server-side primary keys are `uuid`. Records that can originate on a device
  (check entries, field values, diary entries, missed reasons, medication
  administrations, attachments) use **UUID v7 generated on the client**, so they
  have stable identity before they ever reach the server, and sort roughly by
  creation time.
- `_enc` suffix means the column holds ciphertext (see section 9).
- `_bidx` suffix means a blind index: a keyed HMAC of the normalised plaintext,
  used for exact-match lookup without decryption.
- Every mutable table carries `created_at`, `updated_at`, and a `revision bigint`
  fed by one global sequence. `revision` is what sync cursors walk. It is the
  single most important column in the schema.
- Nothing is hard-deleted while retention applies. `archived_at` or `deleted_at`
  is set instead, and the row stays.

```sql
CREATE SEQUENCE global_revision_seq;
-- every syncable table: revision bigint NOT NULL DEFAULT nextval('global_revision_seq')
-- and a trigger that bumps it on UPDATE
```

## 1. Organisation and settings

### org_settings (single row)
| Column | Type | Notes |
| --- | --- | --- |
| id | smallint PK, always 1 | enforced by a check constraint |
| org_name | text | shown in reports and PDF headers |
| timezone | text | IANA name, e.g. `Australia/Melbourne`. Org-wide, configurable. Drives every window and "daily" calculation |
| retention_years | smallint | default 7 |
| late_entry_cutoff_minutes | integer | default 1440. Beyond this, back-fill needs a team leader |
| window_warning_minutes | integer | default 20 |
| escalation_delay_minutes | integer | default 30 |
| session_idle_minutes_web | integer | default 60 |
| session_idle_minutes_mobile | integer | default 720 |
| created_at, updated_at | timestamptz | |

## 2. Users and access

### users
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| email | citext UNIQUE | login identifier, not used for sending anything |
| password_hash | text | argon2id |
| must_change_password | boolean | true on admin-issued credentials |
| display_name | text | |
| role | enum | `admin`, `team_leader`, `nurse`, `worker`, `participant` |
| participant_id | uuid NULL FK | set only when role is `participant` |
| status | enum | `active`, `suspended`, `archived` |
| totp_secret_enc | bytea NULL | |
| totp_enabled_at | timestamptz NULL | |
| failed_attempts | smallint | |
| locked_until | timestamptz NULL | |
| last_login_at | timestamptz NULL | |
| created_by | uuid FK users | |
| created_at, updated_at, revision | | |

Constraint: `role = 'participant'` requires `participant_id IS NOT NULL`, and any
other role requires it to be null.

### recovery_codes
`id, user_id, code_hash, used_at, created_at`. Single use.

### sessions
Web sessions. `id, user_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at`.

### devices
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | device-generated, stable across app restarts |
| user_id | uuid FK | |
| platform | enum | `android`, `ios`, `web` |
| model, os_version, app_version | text | |
| push_token | text NULL | FCM or APNs token |
| last_sync_at | timestamptz NULL | |
| last_sync_revision | bigint NULL | the cursor the device last acknowledged |
| wipe_requested_at | timestamptz NULL | set when the account is suspended, honoured at next contact |
| created_at, updated_at | | |

### refresh_tokens
`id, user_id, device_id, token_hash, family_id, issued_at, expires_at, used_at, revoked_at`.
Reuse of a used token revokes the whole `family_id`.

### team_scopes
Which participants a team leader or nurse oversees.
`id, user_id, participant_id, created_by, created_at, revoked_at`.

### participant_assignments
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| participant_id | uuid FK | |
| user_id | uuid FK | |
| kind | enum | `standing`, `temporary` |
| reason | text NULL | required when `temporary` |
| granted_by | uuid FK users | |
| granted_at | timestamptz | |
| expires_at | timestamptz NULL | required when `temporary` |
| revoked_at | timestamptz NULL | |
| revision | bigint | a change here changes what a device is allowed to hold |

Effective access = `standing` rows not revoked, plus `temporary` rows not revoked
and not expired. This function lives in `packages/shared` and is used by the API
scope layer and by the sync scope calculation.

## 3. Participants

### participants
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| first_name_enc, last_name_enc, preferred_name_enc | bytea | |
| name_search_bidx | bytea | HMAC of lowercased surname, for exact surname lookup |
| dob_enc | bytea | |
| ndis_number_enc | bytea | |
| ndis_number_bidx | bytea UNIQUE | exact lookup without decryption |
| address_enc, phone_enc, email_enc | bytea | |
| photo_attachment_id | uuid NULL FK | |
| notes_enc | bytea NULL | general admin notes, not clinical |
| status | enum | `active`, `archived` |
| archived_at | timestamptz NULL | |
| created_at, updated_at, revision | | |

Listing participants requires decrypting names. At 200 rows that is fine. Do not
add free-text name search over the whole table, use the surname blind index or
client-side filtering of the already-decrypted assigned list.

### participant_alerts
High-visibility flags shown at the top of every screen for that participant.
`id, participant_id, kind (allergy | medical | behavioural | communication | other), text_enc, severity (info | warning | critical), sort_order, active, created_by, created_at, updated_at, revision`.

### emergency_contacts
`id, participant_id, name_enc, relationship_enc, phone_primary_enc, phone_secondary_enc, email_enc, is_primary, sort_order, notes_enc, created_at, updated_at, revision`.

### emergency_plans
`id, participant_id, title, body_enc, updated_by, created_at, updated_at, revision`.
Must be available offline at all times.

## 4. Check templates

### check_templates
`id, name, description, status (active | retired), created_by, created_at, updated_at, revision`.

### check_template_versions
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| template_id | uuid FK | |
| version | integer | increments per template |
| schema | jsonb | the full ordered field definition, frozen |
| status | enum | `draft`, `published`, `superseded` |
| published_at | timestamptz NULL | |
| published_by | uuid NULL FK | |
| created_at, revision | | |

Published versions are immutable. Entries reference the version, not the
template, so historical records always render with the field set they were
recorded against.

`schema` shape:

```json
{
  "fields": [
    { "key": "urine_output", "label": "Urine output", "type": "number",
      "unit": "ml", "decimals": 0, "min": 0, "max": 5000,
      "required": true, "help": "Since the last check", "sort": 10 },
    { "key": "vent_mode", "label": "Ventilator mode", "type": "single_choice",
      "options": [{ "value": "cpap", "label": "CPAP" },
                  { "value": "bipap", "label": "BiPAP" }],
      "required": true, "sort": 20 },
    { "key": "suction_done", "label": "Suction performed", "type": "boolean",
      "required": false, "sort": 30 },
    { "key": "cares", "label": "Cares completed", "type": "checklist",
      "items": [{ "value": "repositioned", "label": "Repositioned" },
                { "value": "mouth_care", "label": "Mouth care" }],
      "required": false, "sort": 40 },
    { "key": "comment", "label": "Comment", "type": "text",
      "multiline": true, "maxLength": 2000, "required": false, "sort": 50 }
  ]
}
```

Field types: `number`, `boolean`, `checklist`, `single_choice`, `multi_choice`,
`text`, `date`, `time`, `datetime`. **No range, threshold or alerting config
exists on a field. That is deliberate.**

`key` is immutable once published. Renaming a label is a new version, changing a
key is a new field.

## 5. Schedules, coverage and windows

### check_schedules
The admin-configured rule. One row per participant per template.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| participant_id | uuid FK | |
| template_id | uuid FK | resolved to the current published version when a window is created |
| name | text | shown to staff, e.g. "Vent observations" |
| active_from | date | |
| active_to | date NULL | |
| status | enum | `active`, `paused`, `ended` |
| created_by, created_at, updated_at, revision | | |

A participant can hold several active schedules at once, for example 2-hourly
vent observations plus a once-daily weight check.

### check_schedule_segments
The grid itself. **This is what an admin sets up**, and a schedule needs at least
one segment.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| schedule_id | uuid FK | |
| window_minutes | integer | default 120 |
| anchor_time | time | local time the grid starts from, e.g. 06:00 |
| applies_from_time | time | start of the part of the day this segment governs |
| applies_to_time | time | end. May be less than `applies_from_time`, meaning it crosses midnight |
| weekdays | smallint[] | days this segment applies. `NULL` means every day |
| sort_order | smallint | |
| created_at, updated_at, revision | | |

One segment with `00:00` to `24:00` and no weekday filter is the simple case: a
flat 2-hourly grid all day, every day. Several segments express different
intervals at different times, which is the common high-acuity pattern:

```
schedule "Vent observations" for Alice Smith
  segment 1: 07:00 → 21:00, every day, window 120, anchor 07:00
  segment 2: 21:00 → 07:00, every day, window 240, anchor 21:00
```

Rules enforced on save, in `packages/shared` so the API and the admin UI agree:

- Segments within one schedule must not overlap in time on the same weekday.
- Gaps are allowed but warned about, since coverage may legitimately account for
  them.
- `window_minutes` should divide evenly into the segment's span. If it does not,
  the final window of the segment is short, and the UI says so rather than
  silently truncating.
- Anchor time must fall on or before `applies_from_time` for the grid to line up
  predictably.
- Changing a segment regenerates future windows only. Windows that already hold
  an entry are never destroyed (see doc 01 §5.3).

The materialiser walks each active segment for each day in the horizon, lays down
the grid from `anchor_time` at `window_minutes` intervals, clips to the segment's
applicable hours, and then applies coverage to set `expected`.

### coverage_patterns
Baseline supported hours.
`id, participant_id, weekday (0-6), start_time, end_time, active_from, active_to, created_by, created_at, revision`.
Multiple rows per weekday allowed. Ranges crossing midnight are stored as two
rows, one ending 24:00 and one starting 00:00 on the next day.

### coverage_exceptions
Dated overrides.
`id, participant_id, starts_at, ends_at, effect (covered | not_covered), reason, created_by, created_at, revision`.
Exceptions win over the pattern. Overlapping exceptions resolve by most recently
created.

### check_windows
The materialised grid. This is the busiest table.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| participant_id | uuid FK | |
| schedule_id | uuid FK | |
| segment_id | uuid FK | which grid rule produced it, kept so history survives a schedule change |
| template_version_id | uuid FK | frozen at materialisation |
| starts_at, ends_at | timestamptz | |
| expected | boolean | false when coverage says nobody from the team is there |
| status | enum | `pending`, `partial`, `complete`, `missed`, `not_expected` |
| completed_at | timestamptz NULL | when the last required field was filled |
| is_late | boolean | completed after `ends_at` |
| late_by_minutes | integer NULL | |
| recalculated_at | timestamptz NULL | set when coverage changed after creation |
| created_at, updated_at, revision | | |

Indexes: `(participant_id, starts_at DESC)`, `(status, ends_at)` for the closer
job, `(revision)` for sync.

Volume: 200 participants x 12 windows a day = roughly 876k rows a year. Partition
by month once past 2 years.

### window_status state machine

```
                    coverage says not covered
   [created] ─────────────────────────────────► not_expected
       │                                              │
       │ coverage says covered                        │ entry recorded anyway
       ▼                                              ▼
    pending ──first value saved──► partial ──all required saved──► complete
       │                              │
       │ ends_at passes               │ ends_at passes
       ▼                              ▼
     missed ◄───────────────────── missed (partial, unresolved)
       │
       │ reason recorded
       ▼
   missed (resolved)   ── or a late entry arrives ──►  complete + is_late
```

`missed` is not a terminal state. A late entry can still complete a missed
window, and the window keeps `is_late` and its miss reason for the record.

## 6. Check entries

### check_entries
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | **UUID v7 generated on the device** |
| window_id | uuid FK | |
| participant_id | uuid FK | denormalised for scope filtering and indexing |
| template_version_id | uuid FK | |
| recorded_by | uuid FK users | who actually entered it |
| recorded_at | timestamptz | device time when the worker recorded it |
| received_at | timestamptz | server time when it arrived, authoritative for lateness |
| status | enum | `partial`, `complete` |
| is_late | boolean | derived from `received_at` vs `window.ends_at`, allowing the device clock to be wrong |
| device_id | uuid FK NULL | |
| edited_at | timestamptz NULL | |
| edit_count | integer | |
| created_at, updated_at, revision | | |

One entry per window per participant. Partial entry means the same row is
updated as more fields are filled, not a second row.

### check_entry_values
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| entry_id | uuid FK | |
| field_key | text | matches a key in the template version schema |
| value_number | numeric NULL | populated for `number` only |
| value_bool | boolean NULL | |
| value_text_enc | bytea NULL | encrypted, for `text` |
| value_json | jsonb NULL | choices, checklist selections, dates and times |
| unit | text NULL | copied from the schema at write time so it survives a version change |
| recorded_at | timestamptz | per-field, because partial entry fills fields at different times |
| recorded_by | uuid FK | |
| created_at, updated_at, revision | | |

Unique on `(entry_id, field_key)`.

**Encryption trade-off, decide before building.** `value_number` is left in
plaintext so trend charts and CSV exports can aggregate in SQL. A bare numeric
with no name attached is weakly identifying, but joined to `participant_id` it is
clinical data. Two options:

- **Option A (recommended):** keep `value_number` plaintext, rely on
  full-disk/volume encryption plus database access control, and encrypt free
  text. Trends and compliance stay simple SQL.
- **Option B:** encrypt everything, and maintain a separate decrypted
  materialised view or reporting table refreshed by a job for trends.

Option A is recommended for v1. Whichever is chosen, record it in doc 10 and do
not mix the two.

### check_entry_revisions
Append-only edit history.
`id, entry_id, field_key, old_value_json, new_value_json, changed_by, changed_at, reason NULL`.
Never updated, never deleted.

### missed_reason_codes
Admin-configurable.
`id, code, label, requires_note, active, sort_order, revision`.
Seed: `asleep`, `refused`, `not_home`, `staff_emergency`, `equipment_unavailable`,
`family_supporting`, `forgot`, `other` (other requires a note).

### window_miss_reasons
`id (uuid v7, device generated), window_id, reason_code_id, note_enc NULL, recorded_by, recorded_at, received_at, device_id, created_at, revision`.
One per window. Editable, with revisions kept in `check_entry_revisions`-style
history.

## 7. Diary

### diary_categories
`id, label, colour, sort_order, active, revision`.
Seed: personal care, behaviour, activity, medical, communication, family contact,
equipment, other.

### diary_entries
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | device-generated UUID v7 |
| participant_id | uuid FK | |
| category_id | uuid FK | |
| body_enc | bytea | |
| body_search_tsv | tsvector NULL | see note |
| occurred_at | timestamptz | when the event happened |
| recorded_by | uuid FK | |
| recorded_at, received_at | timestamptz | |
| visible_to_participant | boolean | default true |
| device_id | uuid NULL | |
| edited_at, edit_count | | |
| deleted_at | timestamptz NULL | soft delete, admin only, audited |
| created_at, updated_at, revision | | |

**Search note.** Encrypted bodies cannot be searched by Postgres full text. Two
options, pick one and record it: (a) drop `body_search_tsv`, decrypt and search
client-side within the user's scope, which is fine for a single participant's
history but poor org-wide; (b) keep an encrypted-at-rest search index outside
Postgres. Recommendation for v1: option (a), scoped search per participant,
because the realistic query is "what happened with this person last week", not
"search everything".

### diary_entry_revisions
`id, entry_id, old_body_enc, new_body_enc, old_category_id, new_category_id, changed_by, changed_at`.

## 8. Attachments

### attachments
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | device-generated |
| owner_type | enum | `diary_entry`, `incident`, `participant_photo` |
| owner_id | uuid | |
| participant_id | uuid FK | for scope checks without a join |
| filename | text | original name, sanitised |
| mime_type | text | allow-list only: jpeg, png, heic, webp, pdf |
| byte_size | bigint | limit 20 MB |
| sha256 | text | dedupe and integrity |
| storage_path | text | relative path on the encrypted volume |
| encryption_key_enc | bytea | per-file data key, wrapped by the master key |
| width, height | integer NULL | images |
| uploaded_by | uuid FK | |
| upload_state | enum | `pending`, `complete`, `failed` |
| created_at, revision | | |

Files live on the VPS disk on an encrypted volume, each file encrypted again with
its own key. The API streams them, they are never served directly by nginx.
Storage is behind an interface so object storage can replace it later without
schema change.

## 9. Clinical modules (later phases)

### care_plans
`id, participant_id, title, status (draft | published | archived), current_version_id, created_by, created_at, updated_at, revision`.

### care_plan_versions
`id, care_plan_id, version, body_enc (rich text as HTML or JSON), status, published_at, published_by, change_summary, created_at, revision`.

### care_plan_reads
`id, care_plan_version_id, user_id, read_at`. Drives the unread marker.

### medications
`id, participant_id, name, form, dose, route, instructions_enc, is_prn, start_date, end_date NULL, requires_witness, active, created_by, created_at, updated_at, revision`.

### medication_schedules
`id, medication_id, time_of_day, weekdays (smallint[] NULL means daily), active_from, active_to, revision`.

### medication_doses
Materialised due doses, same pattern as check windows, same coverage rules.
`id, medication_id, participant_id, due_at, expected, status (pending | given | refused | withheld | not_required | self_administered | missed), revision`.

### medication_administrations
`id (device-generated), dose_id NULL (null for PRN), medication_id, participant_id, administered_at, recorded_at, received_at, status, amount_given NULL, note_enc, reason_enc NULL, outcome_enc NULL, is_late, recorded_by, witnessed_by NULL, device_id, revision`.

`amount_given` is what actually went in, free text and plaintext exactly like
`medications.dose` (D92). Null means the record does not say. Nothing converts,
totals or compares it.

### incidents
`id, participant_id, occurred_at, discovered_at, reported_by, summary_enc, detail_enc, immediate_action_enc, injuries_enc, severity (low | moderate | high), family_notified_at NULL, status (open | under_review | closed), closed_by NULL, closed_at NULL, closure_notes_enc NULL, created_at, updated_at, revision`.

Never visible to `participant` role accounts. Enforce in the scope layer, not
only in the UI.

### incident_actions
`id, incident_id, action_enc, assigned_to, due_at, completed_at, completed_by, revision`.

## 10. Notifications and audit

### notifications
`id, user_id, kind, participant_id NULL, window_id NULL, title, body, deep_link, created_at, sent_at NULL, delivered_at NULL, read_at NULL, failure_reason NULL`.

Bodies contain no clinical detail and no participant surname. A push notification
lands on a lock screen. "Check due for A. Smith" is the maximum detail.

### notification_preferences
`id, user_id, kind, enabled`. Escalation notifications cannot be disabled by
team leaders.

### audit_log
Append-only, tamper-evident.

| Column | Type | Notes |
| --- | --- | --- |
| id | bigserial PK | |
| at | timestamptz | server time |
| actor_user_id | uuid NULL | null for system actions |
| actor_ip, actor_device_id | | |
| action | text | `participant.view`, `check_entry.create`, `check_entry.edit`, `assignment.grant`, `export.csv`, `user.suspend`, `template.publish`, and so on |
| entity_type, entity_id | text, uuid | |
| participant_id | uuid NULL | so a per-participant access history can be produced |
| metadata | jsonb | redacted, never holds clinical values or names |
| prev_hash, hash | text | SHA-256 chain over the previous hash plus this row's canonical form |

No UPDATE or DELETE grant on this table for the application role. A weekly job
verifies the hash chain and alerts on a break.

Views are logged as well as writes. That is the point of an access audit.

### job_runs
`id, job_name, started_at, finished_at, status, detail jsonb`. So a cron that
stopped firing is visible.

## 11. Sync support

### sync_deletions
Tombstones, because a device cannot learn about a row that no longer exists.
`id, entity_type, entity_id, participant_id, deleted_at, revision`.

### sync_scope_changes
When an assignment is revoked, the device must drop that participant's local
data. `id, user_id, participant_id, effect (granted | revoked), at, revision`.

Devices walk both tables with the same `revision` cursor as everything else.

## 12. Encryption strategy

- **Envelope encryption.** A master key from the environment (or a KMS later)
  wraps per-table data keys. Field ciphertext is AES-256-GCM with a random nonce
  per value and the column name as additional authenticated data, so a value
  cannot be moved between columns.
- **Blind indexes** are HMAC-SHA256 with a separate key over the normalised
  plaintext (trimmed, lowercased). They allow exact match only, never prefix or
  range. `ndis_number_bidx` is unique, which also enforces no duplicate
  participants.
- **Key rotation** must be possible without downtime: keys are versioned, the
  ciphertext carries its key version, and a background job re-encrypts.
- **The local database is protected on both platforms, by different means.**
  - *Native (final phase):* SQLCipher with the key in the platform keystore,
    released by biometric unlock.
  - *PWA (v1):* OPFS is origin-scoped and unreadable by other sites, but it is
    not encrypted on disk. So Vigilo encrypts the sensitive columns inside the
    local database with WebCrypto AES-GCM, using a key wrapped by a WebAuthn
    PRF-derived secret (or a PIN-derived key where PRF is unavailable), held in
    memory for the session. Names, diary bodies and free-text values are
    encrypted locally. Timestamps, statuses and numeric values are not, matching
    the server-side trade-off in §6.
  - Either way, the realistic threat is an unlocked, stolen phone rather than a
    stolen file, so also wipe the local database on suspension, on sign-out, and
    after a long period with no successful sync (default 30 days).

## 13. Indexing summary

```sql
CREATE INDEX ON check_windows (participant_id, starts_at DESC);
CREATE INDEX ON check_windows (status, ends_at) WHERE status IN ('pending','partial');
CREATE INDEX ON check_windows (revision);
CREATE INDEX ON check_entries (participant_id, recorded_at DESC);
CREATE INDEX ON check_entries (revision);
CREATE INDEX ON check_entry_values (entry_id);
CREATE INDEX ON check_entry_values (field_key, recorded_at) WHERE value_number IS NOT NULL; -- trends
CREATE INDEX ON diary_entries (participant_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON diary_entries (revision);
CREATE INDEX ON participant_assignments (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON audit_log (participant_id, at DESC);
CREATE INDEX ON audit_log (actor_user_id, at DESC);
```

Every syncable table needs its `revision` index. That is the hot path for every
device every sync.
