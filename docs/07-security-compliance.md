# 07. Security and compliance

Vigilo holds health information about people with disability under Australian
law. Treat every record as sensitive information under the Privacy Act 1988 and
the Australian Privacy Principles.

## 1. Obligations that apply

| Source | What it requires here |
| --- | --- |
| Privacy Act 1988 (Cth) and the APPs | Health information is sensitive information. Collect only what is needed, secure it, allow the individual access to their own record, and destroy or de-identify it when no longer needed |
| Notifiable Data Breaches scheme | A breach likely to cause serious harm must be assessed within 30 days and notified to the OAIC and affected individuals |
| NDIS Practice Standards | Records must be accurate, current, and retained. Participants have a right of access to their own records |
| NDIS record retention | 7 years is the working baseline used here |
| State health records law | Victoria (HRA 2001) and NSW (HRIPA 2002) impose further duties. Confirm which state applies |

Vigilo deliberately does **not** implement the NDIS Commission reportable
incident workflow or the restrictive practice register. The organisation handles
those elsewhere. Note this in any compliance review so it is not mistaken for an
oversight.

## 2. Encryption

**In transit.** TLS 1.3 only, HSTS with a long max-age, no mixed content.
Certificate pinning in the mobile apps is worth considering but complicates
certificate rotation, so it is optional and off by default.

**At rest, database.** Envelope encryption. A master key from the environment
wraps per-table data keys. Field values are AES-256-GCM with a random nonce per
value and the column name as additional authenticated data, so ciphertext cannot
be moved between columns.

Encrypted: participant names, DOB, address, contacts, NDIS number, diary bodies,
free-text check values, care plan bodies, incident narratives, medication
instructions and notes, TOTP secrets.

Not encrypted: numeric check values (see the trade-off in doc 03 §6), timestamps,
foreign keys, statuses, template schemas. These are needed for querying, and the
volume is protected by disk encryption and database access control.

**At rest, files.** Attachments live on an encrypted volume and are additionally
encrypted per file with a data key wrapped by the master key. Files are streamed
through the API with a scope check on every request, never served statically by
nginx.

**At rest, device.** Different mechanisms per platform, same intent.

- *PWA (v1):* OPFS is origin-scoped, so no other site can read it, but it is not
  encrypted on disk. Vigilo therefore encrypts sensitive columns inside the local
  database with WebCrypto AES-GCM. The key is wrapped by a WebAuthn PRF-derived
  secret, or a PIN-derived key (PBKDF2, high iteration count) where PRF is
  unavailable, and held in memory for the session only.
- *Native (final phase):* SQLCipher whole-database encryption with the key in the
  iOS Keychain or Android Keystore.

Be honest about the difference: **an attacker with a rooted or jailbroken device
and physical access can reach PWA local storage more easily than native
storage.** For an app used on staff phones this is an acceptable v1 risk, given
the mitigations below, and it is one of the reasons the native builds still
belong on the roadmap.

Either way: short inactivity lock, remote wipe on suspension, automatic wipe
after 30 days without a successful sync, and a local retention window of 30 days
so a compromised device yields a month of records rather than years.

**Key management.** Keys are versioned and the ciphertext records its key
version, so rotation is a background re-encryption job rather than an outage. The
master key is never in the repository, never in the image, and never in a log.
It comes from the environment now, and should move to a managed KMS if the
deployment ever grows.

**Blind indexes.** HMAC-SHA256 with a separate key over normalised plaintext, for
exact-match lookup of NDIS number and surname. Exact match only. They leak
equality, which is an accepted trade-off for being able to find a participant
without decrypting the table.

## 3. Authentication and access control

- Argon2id password hashing with sensible parameters, minimum 12 character
  passwords, checked against a compromised-password list at set time.
- TOTP mandatory for admin, team leader and nurse. Optional for workers.
  Single-use recovery codes, hashed at rest, shown once.
- Native: 15-minute access tokens, rotating refresh tokens in the platform
  keystore. Reuse of a rotated token revokes the whole family and alerts.
- Web: httpOnly, Secure, SameSite session cookie plus CSRF double-submit on
  mutations. Note the Capacitor caveat recorded from CareLane: the app origin is
  `https://localhost`, which needs explicit CORS allowance and
  `SameSite=None` on any cookie the native app relies on. Get this right at
  first deploy.
- Lockout after 10 failed attempts, cleared by time or by an admin.
- **Scope enforcement is centralised.** One function resolves a principal to the
  set of participant ids they may touch, and every query goes through it. Route
  handlers never assemble access rules themselves. Add an integration test per
  role that asserts a request for an out-of-scope participant returns
  `scope_denied`, not a 404 that leaks existence and not the record.
- Temporary grants expire automatically and cannot be self-issued.

### No email, and what follows from it

There is no transactional email in the system. That is a deliberate choice, and
it has consequences that must be handled rather than discovered:

- **Password reset is an admin action.** The admin generates a one-time password
  shown once in the UI and hands it over directly. `must_change_password` forces
  a change at first use.
- **A locked-out admin is recovered from the server command line.** If the only
  admin loses their password and TOTP device, nobody can fix it through the app,
  so Vigilo ships a break-glass CLI in the API container:

  ```bash
  docker compose exec api npm run admin -- admin:reset-password --email jo@example.org
  docker compose exec api npm run admin -- admin:disable-totp --email jo@example.org
  ```

  Security properties, all required (full list in doc 01 §10.1):

  - **Shell access to the host is the security boundary.** No HTTP endpoint, no
    listener, no remote invocation. Whoever can `docker compose exec` can already
    read the database, so this grants no new capability, it just makes a
    legitimate operation possible without hand-editing rows.
  - **Every invocation writes to the audit log** with actor `system:cli`, the OS
    user, the command and the target account. It cannot suppress its own entry.
    A silent recovery tool is a backdoor.
  - **It cannot read, decrypt or export participant data.** Accounts, sessions
    and the audit chain only. An attacker who reaches it gains access, not
    records, and leaves a trail either way.
  - One-time passwords print once to stdout, are never persisted and never
    logged. `--confirm` is required for destructive commands.
  - Host access is therefore the thing to protect: SSH keys only, no password
    auth, no shared accounts, and a record of who holds access.

  Still keep at least two admin accounts and store recovery codes physically. The
  CLI is the last resort, not the routine path.
- **Nothing sensitive travels by email**, which is a genuine security benefit and
  worth stating explicitly in any privacy assessment.

## 4. Audit

Append-only, hash-chained. Each row hashes its canonical form plus the previous
row's hash, so removing or altering a row breaks the chain. A weekly job verifies
the chain and raises an alert on a break.

**Views are logged, not only writes.** An access audit that only records changes
cannot answer "who looked at this person's record", which is the question that
matters after a privacy complaint. View events are batched to one row per user
per participant per 15 minutes to keep the volume sane.

Logged: authentication (success and failure), participant views, all record
creates, edits and deletes with entity ids, assignment grants and revocations,
template publishes, coverage recalculations, exports (with filters and row
counts), user administration, settings changes, device registration and wipes.

The application database role has INSERT but no UPDATE or DELETE on `audit_log`.
Audit metadata is redacted: entity ids and action names, never clinical values or
names.

## 5. Data residency and retention

- Host in an Australian region. Backups stay in Australia. No third-party
  processor outside Australia, which is straightforward here since there is no
  email provider, no AI service and no error-reporting SaaS.
- Push notifications are the one exception, and the PWA-first choice improves
  this. **Web Push with self-hosted VAPID** goes through the browser vendor's
  push service (Google, Mozilla or Apple) but the **payload is end-to-end
  encrypted to the subscriber's keys**, so the relay sees ciphertext and routing
  metadata, not content. The later native builds move to FCM and APNs, where the
  payload is visible to the provider. Either way the rule stands: **no clinical
  content and no participant surname in a notification.** "Check due for A.
  Smith" is the ceiling, both because it lands on a lock screen and because it
  crosses a border. Document it in the privacy policy.
- Retention: 7 years from the last service date, configurable. After that,
  records are flagged for archival and require an explicit admin action.
  **Nothing is ever deleted silently by a job.**
- Participant right of access is served by the self-access role and the daily
  report PDF export.

## 6. Backups

- Nightly `pg_dump`, encrypted with a key separate from the application master
  key, plus a snapshot of the attachment volume.
- 7 daily, 4 weekly, 12 monthly retained. Offsite copy in Australia.
- **Restores are tested quarterly.** An untested backup is not a backup. A
  documented restore procedure with a target recovery time lives in the repo.
- Startup warns loudly if the last successful backup is stale, the way CareLane
  does.
- Backups contain encrypted fields. Losing the master key means losing the data,
  so the key needs its own documented, separate, offline backup. This is the same
  class of risk as the CareLane signing keystore that exists only on this
  machine.

## 7. Threat model

| Threat | Mitigation |
| --- | --- |
| Lost or stolen phone | Encrypted local DB, biometric lock, short inactivity timeout, remote wipe, 30-day no-sync auto-wipe, 30-day local retention window |
| Rooted or jailbroken device reading PWA local storage | Column-level encryption inside the local DB with an in-memory key, short local retention. Weaker than native SQLCipher, and an accepted v1 trade-off (see §2) |
| Host shell access abused via the admin CLI | Whoever has shell already has the database, so the CLI adds no capability. It is audit-logged on every invocation and cannot read participant data. Protect host access: SSH keys only, no shared accounts, a record of who holds access |
| Malicious service worker or cached bundle | HTTPS only, `sw.js` served `no-cache`, strict CSP, subresource integrity on the built assets, build hash checked by the API |
| Departing staff member retaining access | Instant suspension kills sessions and flags the device for wipe. Assignments audited. Temporary grants expire on their own |
| Curious staff browsing records they have no reason to see | Scope enforcement plus view auditing plus a per-participant access report |
| VPS compromise | Field encryption limits what a database dump yields, but an attacker with the app process has the keys. Reduce blast radius: minimal container, no shell in the image, keys from the environment, host firewalled, SSH keys only, unattended security updates |
| SQL injection | Drizzle parameterised queries, no string-built SQL, Zod validation on every input |
| XSS | Vue escapes by default, care plan rich text sanitised with DOMPurify on write and on render, strict CSP |
| Malicious upload | MIME sniffing rather than trusting the declared type, extension allow-list, size cap, EXIF and GPS stripped, files served only through the API with `Content-Disposition: attachment` |
| Brute force | Rate limits per account and per IP, lockout, TOTP |
| Insider admin abuse | Everything audited with a tamper-evident chain, at least two admins so actions are reviewable |
| Backup theft | Backups encrypted with a separate key |
| Supply chain | Lockfiles committed, `npm audit` in CI, Dependabot, minimal dependency footprint |

## 8. App store requirements

**These apply to the final native phase only.** The PWA has no store review, no
privacy nutrition labels and no account deletion requirement, which is a real
advantage of shipping it first: a working product reaches staff without waiting
on Apple.

Recorded here so the native phase is planned with its true cost. Both stores
treat health-adjacent apps more strictly, and both need work that is easy to
leave too late.

**Apple:**
- Privacy nutrition labels declaring health data collection.
- A published privacy policy URL.
- A working demo account for review, pointed at **staging with fake
  participants**, never production.
- Justification for background modes and push.
- Data safety questions about encryption in transit and at rest.
- Account deletion path (App Store guideline 5.1.1(v)). Vigilo accounts are
  admin-issued and retained for 7 years, so this needs a documented answer:
  in-app request plus admin action plus retention explanation. **Resolve this
  before submission, it is a common rejection.**

**Google Play:**
- Data safety form matching the privacy policy.
- Health app declarations.
- Target API level currency, which forces yearly maintenance releases.
- Sensitive permission justification for camera and notifications.

Both: the app must be usable by a reviewer who is not a support worker, so seeded
demo data has to be realistic.

## 9. Security work that must be in the build

Not optional, and cheaper to do as you go:

1. An integration test per role asserting out-of-scope access is denied.
2. A test asserting the audit log rejects UPDATE and DELETE from the app role.
3. A test asserting no encrypted field is ever returned in plaintext by a list
   endpoint the caller lacks scope for.
4. A CI check that fails if a key, password or token appears in the repository.
5. Dependency audit in CI.
6. A test asserting every admin CLI command writes an audit row, and that the
   CLI has no code path that reads participant data.
7. A test asserting the local database holds no plaintext for encrypted columns
   after a sync (inspect the OPFS file directly).
8. A documented incident response process: who to call, how to assess against
   the NDB scheme, how to notify.
9. Penetration testing before the first production deployment with real
   participant data. This is a system holding health records about vulnerable
   people, and self-review is not enough.
