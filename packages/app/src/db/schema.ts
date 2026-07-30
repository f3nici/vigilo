/**
 * The local database (doc 05 §8).
 *
 * One table per synced entity, plus the outbox and the attachment queue.
 * Every row keeps the API's own DTO as one sealed blob and lifts out only the
 * columns something needs to filter or sort on.
 *
 * That split is the encryption story, not a shortcut. Doc 03 §12: names, diary
 * bodies and free-text values are encrypted locally; timestamps, statuses and
 * numeric values are not. The blob holds everything a row says about a person
 * and is sealed by the secure store; the plain columns are ids, times and
 * states, which is exactly what the server-side trade-off keeps in plaintext
 * too. A `participant_id` in the clear tells an attacker that a record exists,
 * which they already knew from the file being there.
 *
 * Denormalised for read speed, as doc 05 §8 asks: `windows` carries what the
 * Today screen sorts and groups by, so that screen is one query with no joins.
 */

export const LOCAL_SCHEMA_VERSION = 3;

/**
 * Migrations, applied in order and recorded. A device that has been away for
 * two releases walks through both rather than being wiped, because a wipe
 * takes any unsent outbox with it.
 */
export const migrations: readonly { version: number; statements: readonly string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,

      /* ------------------------------------------------------ reference data */

      `CREATE TABLE IF NOT EXISTS participants (
         id          TEXT PRIMARY KEY,
         status      TEXT NOT NULL,
         revision    INTEGER NOT NULL,
         sealed      TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS alerts (
         id             TEXT PRIMARY KEY,
         participant_id TEXT NOT NULL,
         severity       TEXT NOT NULL,
         active         INTEGER NOT NULL,
         sort_order     INTEGER NOT NULL,
         revision       INTEGER NOT NULL,
         sealed         TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS alerts_participant ON alerts (participant_id, sort_order)`,

      `CREATE TABLE IF NOT EXISTS contacts (
         id             TEXT PRIMARY KEY,
         participant_id TEXT NOT NULL,
         sort_order     INTEGER NOT NULL,
         revision       INTEGER NOT NULL,
         sealed         TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS contacts_participant ON contacts (participant_id, sort_order)`,

      `CREATE TABLE IF NOT EXISTS emergency_plans (
         participant_id TEXT PRIMARY KEY,
         revision       INTEGER NOT NULL,
         sealed         TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS templates (
         id       TEXT PRIMARY KEY,
         revision INTEGER NOT NULL,
         sealed   TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS template_versions (
         id       TEXT PRIMARY KEY,
         revision INTEGER NOT NULL,
         sealed   TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS schedules (
         id             TEXT PRIMARY KEY,
         participant_id TEXT NOT NULL,
         revision       INTEGER NOT NULL,
         sealed         TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS reason_codes (
         id         TEXT PRIMARY KEY,
         active     INTEGER NOT NULL,
         sort_order INTEGER NOT NULL,
         revision   INTEGER NOT NULL,
         sealed     TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS diary_categories (
         id         TEXT PRIMARY KEY,
         active     INTEGER NOT NULL,
         sort_order INTEGER NOT NULL,
         revision   INTEGER NOT NULL,
         sealed     TEXT NOT NULL
       )`,

      /* -------------------------------------------------------------- records */

      /*
       * The window_view doc 05 §8 asks for. Everything the Today screen sorts,
       * groups and counts by is a column here, so that screen is one query
       * against one table with no joins and no decryption for the ordering.
       */
      `CREATE TABLE IF NOT EXISTS windows (
         id                   TEXT PRIMARY KEY,
         participant_id       TEXT NOT NULL,
         starts_at            TEXT NOT NULL,
         ends_at              TEXT NOT NULL,
         status               TEXT NOT NULL,
         expected             INTEGER NOT NULL,
         is_late              INTEGER NOT NULL,
         entry_id             TEXT,
         template_version_id  TEXT NOT NULL,
         required_field_count INTEGER NOT NULL,
         filled_required_count INTEGER NOT NULL,
         revision             INTEGER NOT NULL,
         sealed               TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS windows_when ON windows (starts_at)`,
      `CREATE INDEX IF NOT EXISTS windows_participant ON windows (participant_id, starts_at)`,
      `CREATE INDEX IF NOT EXISTS windows_open ON windows (status, ends_at)`,

      `CREATE TABLE IF NOT EXISTS entries (
         id             TEXT PRIMARY KEY,
         window_id      TEXT NOT NULL,
         participant_id TEXT NOT NULL,
         recorded_at    TEXT NOT NULL,
         status         TEXT NOT NULL,
         revision       INTEGER NOT NULL,
         sealed         TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS entries_window ON entries (window_id)`,

      `CREATE TABLE IF NOT EXISTS miss_reasons (
         id        TEXT PRIMARY KEY,
         window_id TEXT NOT NULL,
         revision  INTEGER NOT NULL,
         sealed    TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS miss_reasons_window ON miss_reasons (window_id)`,

      `CREATE TABLE IF NOT EXISTS diary_entries (
         id             TEXT PRIMARY KEY,
         participant_id TEXT NOT NULL,
         occurred_at    TEXT NOT NULL,
         category_id    TEXT NOT NULL,
         deleted_at     TEXT,
         revision       INTEGER NOT NULL,
         sealed         TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS diary_when ON diary_entries (participant_id, occurred_at DESC)`,

      `CREATE TABLE IF NOT EXISTS attachments (
         id             TEXT PRIMARY KEY,
         participant_id TEXT NOT NULL,
         owner_id       TEXT,
         upload_state   TEXT NOT NULL,
         revision       INTEGER NOT NULL,
         sealed         TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS attachments_owner ON attachments (owner_id)`,

      /* --------------------------------------------------------- the outbox */

      /*
       * Doc 05 §5, near enough verbatim. `op_id` is a UUID v7 generated here
       * and is the primary key, which is the whole idempotency guarantee: the
       * same operation cannot be queued twice, and replaying it against the
       * server is a no-op.
       *
       * The payload is sealed like everything else. An outbox row is a diary
       * body or a set of observations that has not been sent yet, which makes
       * it the most sensitive thing on the device, not the least.
       */
      `CREATE TABLE IF NOT EXISTS outbox (
         op_id            TEXT PRIMARY KEY,
         seq              INTEGER NOT NULL,
         kind             TEXT NOT NULL,
         entity_id        TEXT NOT NULL,
         participant_id   TEXT NOT NULL,
         sealed_payload   TEXT NOT NULL,
         created_at       TEXT NOT NULL,
         first_attempt_at TEXT,
         next_attempt_at  TEXT NOT NULL,
         attempts         INTEGER NOT NULL DEFAULT 0,
         last_error       TEXT,
         state            TEXT NOT NULL DEFAULT 'pending'
       )`,
      `CREATE INDEX IF NOT EXISTS outbox_ready ON outbox (state, next_attempt_at, seq)`,

      /*
       * Photos, queued separately because a 3 MB image must never hold up a
       * 2 KB check entry (doc 05 §7). The bytes live here as a blob until the
       * server confirms receipt.
       */
      `CREATE TABLE IF NOT EXISTS attachment_queue (
         attachment_id  TEXT PRIMARY KEY,
         participant_id TEXT NOT NULL,
         mime_type      TEXT NOT NULL,
         byte_size      INTEGER NOT NULL,
         bytes          BLOB NOT NULL,
         created_at     TEXT NOT NULL,
         attempts       INTEGER NOT NULL DEFAULT 0,
         next_attempt_at TEXT NOT NULL,
         last_error     TEXT,
         state          TEXT NOT NULL DEFAULT 'pending'
       )`,
      `CREATE INDEX IF NOT EXISTS attachment_queue_ready ON attachment_queue (state, next_attempt_at)`,
    ],
  },

  /*
   * Phase 7. Added as a second migration rather than folded into the first,
   * because a device already holding records must walk to it rather than be
   * wiped: a wipe takes the outbox with it, and the outbox is the one thing on
   * the device that exists nowhere else.
   */
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS medications (
         id             TEXT PRIMARY KEY,
         participant_id TEXT NOT NULL,
         name           TEXT NOT NULL,
         is_prn         INTEGER NOT NULL,
         active         INTEGER NOT NULL,
         revision       INTEGER NOT NULL,
         sealed         TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS medications_participant ON medications (participant_id, name)`,

      /*
       * The dose list the Today screen sorts and groups by, same idea as
       * `windows`: everything it filters on is a column, so that screen is one
       * query with no joins and no decryption for the ordering.
       */
      `CREATE TABLE IF NOT EXISTS medication_doses (
         id                TEXT PRIMARY KEY,
         participant_id    TEXT NOT NULL,
         medication_id     TEXT NOT NULL,
         due_at            TEXT NOT NULL,
         status            TEXT NOT NULL,
         expected          INTEGER NOT NULL,
         administration_id TEXT,
         revision          INTEGER NOT NULL,
         sealed            TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS doses_when ON medication_doses (due_at)`,
      `CREATE INDEX IF NOT EXISTS doses_participant ON medication_doses (participant_id, due_at)`,

      `CREATE TABLE IF NOT EXISTS medication_administrations (
         id              TEXT PRIMARY KEY,
         participant_id  TEXT NOT NULL,
         medication_id   TEXT NOT NULL,
         dose_id         TEXT,
         administered_at TEXT NOT NULL,
         revision        INTEGER NOT NULL,
         sealed          TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS administrations_when
         ON medication_administrations (participant_id, administered_at DESC)`,
    ],
  },

  /*
   * Phase 8. Care plans only: incidents are deliberately not held on a device
   * (doc 05 §3 lists what flows, and they are not on it). Raising one needs the
   * detail a person types sitting down afterwards, and an incident narrative is
   * the most sensitive text in the product to leave on a phone (D67).
   */
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS care_plans (
         id             TEXT PRIMARY KEY,
         participant_id TEXT NOT NULL,
         title          TEXT NOT NULL,
         unread         INTEGER NOT NULL,
         revision       INTEGER NOT NULL,
         sealed         TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS care_plans_participant ON care_plans (participant_id, title)`,
    ],
  },
];

/** Every table holding synced or queued data, for a wipe or a scope purge. */
export const dataTables = [
  'participants',
  'alerts',
  'contacts',
  'emergency_plans',
  'templates',
  'template_versions',
  'schedules',
  'reason_codes',
  'diary_categories',
  'windows',
  'entries',
  'miss_reasons',
  'diary_entries',
  'attachments',
  'medications',
  'medication_doses',
  'medication_administrations',
  'care_plans',
  'outbox',
  'attachment_queue',
] as const;

/**
 * Which table each synced entity lands in, and the plain columns lifted out of
 * its DTO. One place, so a change to an entity cannot update the writer and
 * forget the reader.
 */
export const entityTables: Record<string, string> = {
  participant: 'participants',
  participant_alert: 'alerts',
  emergency_contact: 'contacts',
  emergency_plan: 'emergency_plans',
  check_template: 'templates',
  check_template_version: 'template_versions',
  check_schedule: 'schedules',
  missed_reason_code: 'reason_codes',
  diary_category: 'diary_categories',
  check_window: 'windows',
  check_entry: 'entries',
  window_miss_reason: 'miss_reasons',
  diary_entry: 'diary_entries',
  attachment: 'attachments',
  medication: 'medications',
  medication_dose: 'medication_doses',
  medication_administration: 'medication_administrations',
  care_plan: 'care_plans',
};

/** Tables keyed by participant, which a scope revocation clears (doc 05 §4). */
export const participantScopedTables = [
  'participants',
  'alerts',
  'contacts',
  'emergency_plans',
  'schedules',
  'windows',
  'entries',
  'diary_entries',
  'attachments',
  'medications',
  'medication_doses',
  'medication_administrations',
  'care_plans',
] as const;
