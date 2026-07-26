# 05. Offline sync design

This is the highest-risk part of Vigilo. Support workers are in homes with poor
signal and the app has to be trusted for clinical records. Read this before
writing any sync code.

## 1. Requirements

A worker with no connection must be able to:

- Open the app (biometric unlock, no network).
- See their assigned participants, alerts, emergency contacts and care plans.
- See today's check windows and their status.
- Record a check entry, including partial entry across several visits.
- Record a missed-check reason.
- Write a diary entry and attach photos.
- Sign off medication (later phase).

When connectivity returns, everything uploads with no user action. Nothing is
lost, nothing is duplicated, nothing is silently overwritten.

## 2. Why a custom sync layer

Vigilo's data is unusually friendly to sync:

- Records are **append-mostly.** A check entry is created once by one worker on
  one device. Edits exist but are rare and human-initiated.
- There is **no shared editable document.** Two workers do not co-edit a diary
  entry.
- Each record has **one natural owner window** in time, and there is only ever
  one person on site with a participant.
- The server is the sole authority for schedules, windows, coverage and
  templates. Those flow one way, server to device, and are never edited offline.

That means a general CRDT or a replication engine like PowerSync, ElectricSQL or
RxDB solves problems Vigilo does not have, at the cost of a service to host and a
data model to inherit. A revision-cursor pull plus an idempotent outbox push is
roughly 1,500 lines, fully self-hosted, and debuggable by reading a table.

The trade-off accepted: sync code is Vigilo's own responsibility, so it needs
real tests (section 9) rather than trust in someone else's library.

## 3. Direction of flow

| Data | Direction | Notes |
| --- | --- | --- |
| Participants, alerts, contacts, emergency plans | server to device | read-only offline |
| Check templates and versions | server to device | read-only offline |
| Schedules, coverage patterns and exceptions | server to device | read-only offline |
| Check windows | server to device | **generated only on the server** |
| Check entries and values | both | created and edited on device |
| Miss reasons | both | created on device |
| Diary entries | both | created and edited on device |
| Attachments | both | separate queue, see section 7 |
| Care plans | server to device | read-only, read receipts go up |
| Medications and doses | server to device | administrations go up |
| Assignments and scope | server to device | drives what the device may hold |

**Windows are never created on the device.** This is the key simplification. The
device holds a materialised window list pushed down from the server, and can
only attach entries to windows it already has. The window materialiser runs 7
days ahead, so a device that has been offline for a week still has windows to
record against. If a device somehow has no window for right now, the entry is
recorded with `windowId: null` plus its timestamp, and the server binds it to the
correct window on receipt.

## 4. Pull: the revision cursor

Every syncable row carries `revision bigint` from one global Postgres sequence,
bumped on insert and update. A device stores the highest revision it has fully
applied.

```
GET /sync/changes?since=84102&limit=500
→ { changes: [ {entity, op, row}, … ],
    tombstones: [ … ],
    scopeChanges: [ … ],
    nextRevision: 84610,
    hasMore: false }
```

Rules:

1. **Scope is applied server-side.** The response contains only rows for
   participants the user can currently see. A device never receives data it
   should not hold.
2. **Ordered by revision, applied in a single local transaction per page.** The
   cursor advances only after the page commits, so an interrupted sync replays
   the page rather than skipping it.
3. **Tombstones** carry deletions, since an absent row is indistinguishable from
   an unchanged one.
4. **Scope changes** carry grants and revocations. On a revoke, the device
   deletes every local row for that participant immediately, before anything
   else in the page is applied. On a grant, the device requests a bootstrap
   fetch for that participant only.
5. Pull runs on app foreground, on connectivity regained, on a 5-minute timer
   while foregrounded, and on a background fetch task.

### Bootstrap

A new device, a reinstall, or a device more than `N` days stale calls
`/sync/bootstrap`, which returns the whole scoped snapshot and a starting
revision. Cheaper and safer than walking a long change history. Bootstrap is
also the recovery path for any local corruption: wipe local, bootstrap again.
Anything sitting in the outbox is pushed **before** a wipe, and if it cannot be
pushed it is exported to a local recovery file rather than destroyed.

### Retention window on device

Devices hold: all assigned participants and their reference data, windows from
7 days back to 7 days forward, check entries and diary entries for 30 days.
Older data is fetched on demand and requires a connection. This keeps the local
database small and bounds bootstrap size.

## 5. Push: the outbox

Every local mutation writes two things in one local transaction: the row itself
(so the UI updates instantly) and an outbox operation.

```sql
CREATE TABLE outbox (
  op_id        TEXT PRIMARY KEY,     -- UUID v7, generated on device
  seq          INTEGER,              -- local monotonic ordering
  entity       TEXT,                 -- check_entry, diary_entry, miss_reason, …
  entity_id    TEXT,
  op           TEXT,                 -- create, update
  payload      TEXT,                 -- JSON
  created_at   TEXT,
  attempts     INTEGER DEFAULT 0,
  last_error   TEXT,
  state        TEXT DEFAULT 'pending' -- pending | sending | failed | needs_user
);
```

Push behaviour:

- Batches of up to 50 operations in `seq` order to `POST /sync/push`.
- **Idempotent by `op_id`.** The server records applied op ids and returns
  `duplicate` for a replay, so a response lost on a flaky connection is harmless.
  This is what makes retry safe, and it is the single most important property in
  the design.
- **Per-operation results.** One rejected operation does not block the queue.
  Applied and duplicate operations are deleted from the outbox, rejected ones
  move to `needs_user`, transient failures stay `pending`.
- Retry with exponential backoff and jitter: 5s, 15s, 1m, 5m, 15m, then hourly.
  Cap at 24 hours, then surface it to the user.
- Triggered on connectivity regained, on app foreground, on tab visibility, on a
  timer, and from a background task where the platform has one. See §8.2: iOS
  has none, so background sync is never the only path.
- **Ordering matters within an entity.** Operations for the same `entity_id` are
  sent in `seq` order and the server applies them in the order received. Create
  before update is guaranteed by local sequence.

### Visible queue state

The user always knows where they stand. The app shows a persistent indicator:
`synced`, `n pending`, or `needs attention`. Tapping it lists what is queued.
Silent queues are how records get lost and trust gets destroyed, so the indicator
is a hard requirement, not a nice-to-have.

## 6. Conflicts

Genuine conflicts are rare by design. The full set:

| Situation | Resolution |
| --- | --- |
| Two devices write different fields of the same entry | Merge per field. `check_entry_values` is keyed by `(entry_id, field_key)`, so different fields never collide |
| Two devices write the **same** field of the same entry | Last write by server `received_at` wins. The losing value is preserved in `check_entry_revisions` and the entry is flagged so a human can see both |
| Device edits an entry an admin already edited | Same rule, both versions kept in revisions |
| Device submits against a superseded template version | `template_version_mismatch`. The device downloads the new version, maps values by matching field key, and shows the worker a confirmation screen with anything that no longer fits. Never silently discarded, never silently remapped |
| Device submits for a participant it can no longer see | Server accepts and stores it (the care happened, the record must exist), returns `applied`, then the device purges its local copy. Refusing would destroy a real clinical record |
| Device submits for a window that has been deleted by a schedule change | Server rebinds by timestamp to the correct current window, or creates an out-of-schedule entry if none matches |
| Clock skew: device time is wrong | `recorded_at` from the device is stored for the record, `received_at` from the server decides lateness. Skew beyond 5 minutes is logged and shown to the user as a warning to fix their device clock |

Everything else is not a conflict, it is a bug.

## 7. Attachments

Separate queue, because photos are large and cannot block a 2 KB check entry.

- Photo is captured, downscaled on device (long edge 2048px, JPEG quality 80),
  and written to app storage with a generated UUID.
- The diary entry references the attachment id and syncs immediately. The entry
  is never held back waiting for its photo.
- The attachment queue uploads separately, resumable, preferring unmetered
  networks by default with a per-user "upload on mobile data" setting.
- The UI shows a placeholder with an upload state on entries whose photos have
  not yet arrived.
- Local originals are deleted only after the server confirms receipt and the
  hash matches.

## 8. Local database

**SQLite on both platforms, one schema, one set of queries.**

| | PWA (v1) | Native (final phase) |
| --- | --- | --- |
| Engine | `@sqlite.org/sqlite-wasm` over OPFS | `@capacitor-community/sqlite` |
| At-rest protection | Sensitive columns encrypted with WebCrypto AES-GCM, key from WebAuthn PRF or a PIN | SQLCipher whole-database encryption |
| Durability | Good on Android. **iOS may evict after ~7 days unused** | Never evicted |
| Access | Worker thread with OPFS SyncAccessHandle | Native thread |

Choosing SQLite for the PWA rather than IndexedDB is what keeps this table short.
The local schema, its migrations and every query are written once and reused
verbatim when the native builds arrive. The cost is about 1 MB of WASM, cached by
the service worker after first load.

Local schema mirrors the server's shape but denormalised for read speed: a
`window_view` table carrying the participant name, template name and status so
the home screen is a single query.

Wipe triggers: sign-out, account suspension detected, remote wipe flag on the
device record, 30 consecutive days without a successful sync, and uninstall or
site-data clear (automatic). Wipe always attempts an outbox flush first.

### 8.1 iOS storage eviction, the one real PWA weakness

Safari can clear OPFS data after roughly 7 days without the PWA being opened.
This is the structural cost of shipping PWA-first and it must be designed
around, not noted and forgotten.

- Call `navigator.storage.persist()` during the install flow. Installed PWAs on
  iOS are usually granted it, which greatly reduces eviction risk, but it is a
  request and not a guarantee.
- **Sync aggressively.** Any connection at all triggers a push. The correct
  outbox depth is zero, and the design should never rely on data sitting locally
  for days.
- Show outbox depth and age in the sync indicator, and warn at 24 hours.
- On startup, detect an empty local database with a live session and treat it as
  eviction: bootstrap fresh and log it, rather than presenting an empty screen
  that looks like data loss.
- Eviction destroys unsent outbox items and there is no recovery from it. That
  is the honest limit of the PWA, and it is the strongest single argument for
  eventually shipping the native builds.

### 8.2 Background sync

| Platform | Mechanism | Reliability |
| --- | --- | --- |
| Android PWA (Chrome) | Background Sync API and Periodic Background Sync | Good |
| iOS PWA | None. Web Background Sync is unimplemented | Sync happens on next open only |
| Desktop PWA | Background Sync | Good |
| Native (later) | WorkManager, BGProcessingTask | Good on Android, best-effort on iOS |

Because iOS has no background sync at all, **foreground sync is the primary
path everywhere and background sync is only an optimisation.** Sync on: app
open, tab visible, connectivity regained, a 5-minute timer while foregrounded,
and immediately after any local write. Workers open the app every 2 hours by
definition, which is what makes this acceptable.

## 9. Testing requirements

Sync is not "tested by using the app". Required before the PWA ships, and run
again unchanged against the native builds later:

1. **Unit tests** for the window state machine, coverage resolution and
   completeness rules, run against the same `packages/shared` code the server
   uses. Same inputs must give the same outputs on both sides.
2. **Idempotency tests:** replay every operation type twice, three times, and
   out of order. Assert exactly one record results.
3. **Interruption tests:** kill the process mid-push and mid-pull, restart,
   assert no loss and no duplication.
4. **Airplane-mode scenario test:** 48 hours offline, 24 windows recorded, scope
   revoked for one participant midway, then reconnect. Assert every entry lands,
   the revoked participant's local data is gone, and the entries recorded for
   them before revocation still reached the server.
5. **Clock skew test:** device clock 3 hours fast and 3 hours slow. Assert
   lateness is computed from server time and the record keeps device time.
6. **Template version change mid-flight:** publish a new version while a device
   holds an unsent entry against the old one. Assert the confirmation flow.
7. **Load test:** 300 devices pulling changes concurrently. Assert the
   `revision` indexes hold up.
8. **PWA lifecycle tests**, specific to shipping in a browser:
   - Service worker update while an entry is half-filled. Assert the update is
     deferred and the in-progress entry survives.
   - Hard refresh mid-push. Assert idempotency holds.
   - OPFS eviction simulated by clearing storage with a live session. Assert the
     app detects it, bootstraps, and reports it rather than showing an empty
     screen.
   - Two tabs open at once. Assert the OPFS worker serialises access and the
     outbox is not double-sent.
   - Run in a real installed PWA on Android and on iOS Safari 17, not only in a
     desktop browser. Playwright covers the mechanics, actual devices catch the
     platform behaviour.

## 10. Failure modes to design against

| Failure | Mitigation |
| --- | --- |
| Silent queue growth, worker thinks it saved | Persistent sync indicator, plus a warning banner past a threshold and a push notification if the outbox is stale for 24 hours |
| Worker uninstalls the app with unsent data | Warn on sign-out with pending items. Nothing can stop an uninstall, so keep the queue short by syncing aggressively whenever any connection exists |
| Local DB corruption | Bootstrap recovery path, outbox exported to a file first |
| Server-side revision sequence gap or rollback from a DB restore | Devices detect a `nextRevision` lower than their cursor and force a bootstrap |
| Device holds data after access is revoked | Scope changes applied first in each page, and a revocation forces a sync attempt via a silent push |
| Two workers on the same participant at once | Rare in practice (one person on site), handled by per-field merge |
| Very long offline period | Windows are materialised 7 days ahead. Past 7 days the device records entries with `windowId: null` and the server binds them on arrival |
| **iOS evicts OPFS with unsent entries queued** | `navigator.storage.persist()` at install, aggressive syncing so the queue is normally empty, visible outbox depth, 24-hour stale warning. Unrecoverable if it happens, and the main reason the native builds still matter |
| Service worker serves a stale bundle after deploy | `index.html` and `sw.js` served `no-cache`, build hash sent with every request, `update_required` from the API forces a refresh |
| Worker never installs the PWA and runs it in a tab | A tab has no reliable offline storage or push. Detect display mode, and if a worker signs in from a plain tab, prompt to install and explain what they lose without it |
