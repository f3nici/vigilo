# 01. Product requirements

## 1. Problem

A disability support team supports multiple participants, each in their own
home. Staff currently record two things on paper or in disconnected tools:

1. **A diary.** Free-text notes about what happened during the day.
2. **Regular observation checks.** Clinical readings taken on a fixed cycle,
   typically every 2 hours. Examples given: ventilator output, urine output.
   What is recorded differs per participant and is decided by an admin, not
   hard-coded.

Paper records get lost, cannot be searched, cannot be reported on, and give no
visibility into whether a check was actually done. Signal in participants'
homes is often poor, so anything that requires a live connection fails in the
field.

## 2. Product summary

Vigilo is a self-hosted care records system for one support organisation. It
runs as a web app for office use and admin configuration, and as Android and
iOS apps for staff in the field. The field apps work fully offline and sync
when a connection returns.

Vigilo does **not** track shifts, rosters, clock-in/out, timesheets or billing.

## 3. Users and roles

Five roles. A user has exactly one role.

### 3.1 Support worker
The primary field user. Almost always on mobile.

- Sees only participants explicitly assigned to them.
- Records check entries and diary entries.
- Records a reason when a check window is missed.
- Reads care plans, emergency contacts and alerts for assigned participants.
- Signs off medication administration (later phase).
- Cannot see other workers' assignments, cannot change any configuration.

### 3.2 Team leader / coordinator
Supervises a subset of participants and staff.

- Everything a support worker can do.
- Sees all participants within their scope, whether assigned or not.
- Reviews check compliance and diary entries across their scope.
- Grants temporary participant access to a worker covering a shift.
- Receives escalation notifications for overdue checks.
- Cannot change global settings, cannot create admins.

### 3.3 Nurse / clinical
Clinical oversight for participants with complex needs.

- Read access to all clinical records for participants in their scope.
- Authors and publishes care plans.
- Defines check templates jointly with admins (same permission as admin for
  templates, but not for user management or system settings).
- Reviews and closes incidents.

### 3.4 Admin
Runs the system.

- Full access to all participants and all records.
- Creates, suspends and deletes user accounts, and issues credentials.
- Creates and versions check templates, defines fields and units.
- Sets each participant's check schedule, window length and coverage pattern.
- Configures diary categories, missed-check reason codes, org settings,
  timezone, retention.
- Views the audit log.
- Cannot bypass the audit log. Every admin action is recorded.

### 3.5 Participant (self-access)
The person receiving support, logging in to see their own record.

- Read-only.
- Sees their own diary entries, check history and daily reports.
- **Staff-controlled visibility:** any diary entry can be marked not visible to
  the participant. Default is visible. Incident records are never visible.
- Sees nothing about staff beyond the name of who recorded an entry, and
  nothing about any other participant.

### 3.6 Access rules

| | Worker | Team leader | Nurse | Admin | Participant |
| --- | --- | --- | --- | --- | --- |
| View assigned participant record | yes | yes (scope) | yes (scope) | all | own only |
| Record check entry | yes | yes | yes | yes | no |
| Record diary entry | yes | yes | yes | yes | no |
| Edit own entry | yes (audited) | yes | yes | yes | no |
| Edit another user's entry | no | yes (audited) | yes (audited) | yes (audited) | no |
| Record missed-check reason | yes | yes | yes | yes | no |
| Read care plan | yes | yes | yes | yes | no |
| Write care plan | no | no | yes | yes | no |
| Raise incident | yes | yes | yes | yes | no |
| Close incident | no | yes | yes | yes | no |
| Manage participants | no | no | no | yes | no |
| Manage users | no | no | no | yes | no |
| Manage check templates | no | no | yes | yes | no |
| Manage schedules and coverage | no | yes (scope) | no | yes | no |
| Grant temporary access | no | yes (scope) | no | yes | no |
| View audit log | no | own scope | no | yes | no |
| Org settings | no | no | no | yes | no |

## 4. Participants

A participant is an independent record. There is no house, site or group
grouping. Each participant has:

- Name, preferred name, date of birth, photo (optional).
- Address, phone, and other contact details.
- NDIS number (searchable without decrypting the whole table, see data model).
- Status: active or archived. Records are never hard-deleted while retention
  applies.
- Emergency contacts, ordered, with a designated primary.
- Alerts: short, high-visibility flags shown at the top of every screen for that
  participant. Examples: allergies, seizure plan, DNR status, communication
  needs. Each has a severity that drives its colour.
- An assignment list: which staff can see them, and until when.

### 4.1 Assignment and temporary access

Workers see only participants assigned to them. Assignments are created by an
admin, and can be created by a team leader within their scope.

A **temporary grant** has an expiry timestamp and a mandatory reason. It behaves
exactly like an assignment until it expires, then access ends automatically. All
grants, uses and expiries are written to the audit log. A grant can be revoked
early.

There is no self-service break-glass. A worker cannot grant themselves access.

## 5. Checks (the core feature)

### 5.1 Concept

A **check template** is an admin-defined form. A **schedule** attaches a template
to a participant with a window length. The system generates **check windows**
forward in time. A worker records a **check entry** against a window.

The window is what matters, not the exact clock time. Requirement as stated:
"it's a 2 hour window to record the data, this might be different for different
clients." So window length is per participant, defaulting to 120 minutes.

### 5.2 Check templates

Admins (and nurses) create templates. A template has a name, a description and
an ordered list of fields.

Field types:

| Type | Config | Renders as |
| --- | --- | --- |
| `number` | unit, decimal places, min/max as input sanity bounds only | numeric keypad with unit suffix |
| `boolean` | label | yes/no toggle |
| `checklist` | list of items | multiple tick boxes, each independently ticked |
| `single_choice` | option list | radio group or dropdown |
| `multi_choice` | option list | multi-select chips |
| `text` | single or multi line, max length | text input, dictation available via the OS keyboard |
| `date` | | date picker |
| `time` | | time picker |
| `datetime` | | combined picker |

Every field has: a stable key, a display label, optional help text, a required
flag, and a sort order.

**No normal ranges.** Explicitly out of scope. Vigilo records values, it does
not judge them. No thresholds, no colour-coding by value, no clinical alerting.

**Templates are versioned.** Publishing a change creates a new version. Existing
entries stay bound to the version they were recorded against, so a form that
changes in March does not corrupt February's records. Historical records render
with their original field set. Draft versions are editable, published versions
are immutable.

### 5.3 Schedules and windows

Per participant, per template:

- `window_minutes` (default 120).
- An anchor time that windows are generated from, so windows land predictably
  (e.g. anchored at 06:00 gives 06:00-08:00, 08:00-10:00 and so on).
- Active from and optional active to dates.

Windows are materialised by a background job on a rolling horizon (generate
forward 7 days, keep the past). Materialising rather than computing on the fly
matters because windows carry state (complete, partial, missed, not expected)
and because devices need to hold a concrete list offline.

A participant can have more than one active schedule, for example 2-hourly vent
observations plus a once-daily weight check.

### 5.4 Coverage: when checks are expected

Not every hour is covered by the support team. Families often provide support
and will not be entering data. Those gaps must not be counted as missed checks.

Two mechanisms, both per participant:

1. **Weekly coverage pattern.** The baseline supported hours, set by an admin as
   day-of-week time ranges. For example Monday to Friday 07:00 to 19:00, Saturday
   09:00 to 17:00, Sunday not covered. Multiple ranges per day are allowed.
2. **Coverage exceptions.** Dated overrides for reality: a family holiday, a
   hospital admission, a one-off extra shift. An exception can either add
   coverage or remove it, has a start and end timestamp, a reason, and records
   who created it.

A window whose time falls outside coverage is created with status
`not_expected`. It is not counted as missed, does not generate a notification,
and is excluded from compliance percentages. It is still visible in the
timeline, greyed out, so the record shows the gap was intentional. A worker who
is there anyway can still record an entry against a `not_expected` window, which
flips it to complete.

Coverage changes apply to future windows immediately and can be backdated by an
admin, which recalculates the affected windows' expected status. Recalculation
is audited.

### 5.5 Recording a check entry

- The entry records **who** entered it and the **actual timestamp**, held
  separately from which window it belongs to.
- **Partial entry is allowed.** A worker can fill some fields now and the rest
  later in the same window. The window shows as `partial` until every required
  field has a value, then `complete`.
- **Back-fill is allowed.** An entry can be recorded after its window has
  closed. It is accepted and flagged `late`, with the lateness recorded in
  minutes. Late entries are visible as late in reports. There is a configurable
  cut-off (default 24 hours) after which back-fill needs a team leader.
- **Editing is allowed after submission.** The original value is preserved. Every
  edit writes a revision row with the old value, the new value, who changed it
  and when. The current value is what displays, with an "edited" marker and the
  full history one tap away.
- Entry IDs are generated on the device (UUID v7) so offline entries have stable
  identity before they reach the server.

### 5.6 Missed checks

When a window closes with no entry and coverage says it was expected, it becomes
`missed`.

- **A reason is mandatory.** The next person to open that participant is
  prompted for the missed window. They pick a reason code from an
  admin-configurable list (examples: participant asleep, participant refused,
  participant not home, staff attending emergency, equipment unavailable,
  forgot to record) and can add a free-text note. Some reason codes can be
  configured to require the note.
- Unresolved missed windows are surfaced persistently at the top of the
  participant screen until a reason is given.
- Missed windows and their reasons appear in the compliance report.

### 5.7 Overdue notifications

- A push notification fires to the assigned worker(s) when a window is within a
  configurable warning period of closing (default 20 minutes before close) with
  no entry recorded.
- A second notification fires when the window closes unrecorded.
- If the window is still unresolved after a configurable escalation delay
  (default 30 minutes), a notification goes to the team leader in scope.
- No notifications for `not_expected` windows.
- Quiet hours are respected per participant coverage, so overnight windows only
  notify when overnight is actually covered.

## 6. Diary

- Timestamped free-text entries against a participant.
- Every entry has a **category**, chosen from an admin-configurable list with
  colours. Suggested starting set: personal care, behaviour, activity, medical,
  communication, family contact, equipment, other.
- `occurred_at` is separate from `created_at`, so a worker can log something that
  happened earlier in the shift.
- **Attachments:** photos and files on an entry. Photos are captured in-app,
  downscaled on device before upload, and stored encrypted. Multiple per entry.
- **Visibility:** each entry has a `visible_to_participant` flag, default true,
  which staff can turn off.
- Editable after submission with the same revision history rules as checks.
- Full-text search across diary entries within the user's access scope.
- No structured shift-handover document in v1 (staff read the day's timeline
  instead), and no voice-to-text feature beyond the OS keyboard's own dictation.

## 7. Clinical modules

All four are in scope, but after the core (see the roadmap).

### 7.1 Care plans
A per-participant document holding standing instructions. Authored by nurses and
admins, versioned, with draft and published states. Workers read the published
version. Publishing a new version notifies assigned workers, and the app shows
an unread marker until they open it. Rich text with headings and lists, no
free-form file upload as the primary format.

### 7.2 Medication administration record
- Medications per participant: name, form, dose, route, instructions, PRN flag,
  start and end dates, active flag.
- Scheduled medications generate due times, using the same coverage rules as
  checks so family-administered doses are not counted as missed.
- Sign-off per dose with status: given, refused, withheld, not required, or
  self-administered. Refused and withheld require a note.
- Optional second-person witness on a dose, configurable per medication.
- PRN medications are recorded ad hoc with the reason and the outcome.
- Full audit trail, no deletion.

### 7.3 Incidents
- A structured record separate from the diary, raisable by any staff role.
- Fields: when it occurred, when it was discovered, who was involved, what
  happened, immediate action taken, injuries, severity, whether family was
  notified and when.
- Status workflow: open, under review, closed. Only team leaders, nurses and
  admins close.
- Follow-up actions with an assignee and a due date.
- Exportable as a PDF.
- Never visible to participant self-access accounts.
- **NDIS Commission reportable-incident fields, the 24-hour and 5-day
  notification tracking, and the restrictive practice register are explicitly
  out of scope.** The organisation handles those outside Vigilo.

### 7.4 Emergency contacts and plans
- Ordered contact list with relationship, phone numbers and a primary flag.
- One-tap dial from mobile.
- Emergency plan text per participant, plus the alerts described in section 4.
- Reachable in one tap from the participant screen and available offline. This
  is the one thing that must never require a network.

## 8. Reporting

All reports respect the requesting user's access scope.

1. **Daily participant report (PDF).** One participant, one day. Header with
   participant details and alerts, then the day's timeline: every check window
   with its values or its missed reason, every diary entry, medication
   administrations. Shows late and edited markers. Suitable for handing to
   family or an auditor. Also available as a date range.
2. **Trends.** A chart of any numeric check field over a chosen period for one
   participant, with the raw data table underneath. Handles gaps honestly by
   showing them as gaps, not interpolating.
3. **Compliance report.** Check completion by participant, by worker, and by
   period. Columns: windows expected, completed, completed late, missed, missed
   with reason, missed without reason, plus a completion percentage.
   `not_expected` windows are excluded from the denominator and shown separately.
4. **CSV export.** Raw check entries, diary entries or medication records for a
   date range, one row per record, with a column per field key for checks.
   Exports are audit-logged, including who exported what.

## 9. Notifications

Native push via FCM (Android) and APNs (iOS), delivered through the Capacitor
push plugin.

Triggers in v1:
- Check window closing soon, unrecorded.
- Check window closed, unrecorded.
- Escalation to team leader for an unresolved missed window.
- New or updated published care plan for an assigned participant.
- Temporary access granted or about to expire.

Notifications carry a deep link that opens the relevant participant and window.
Per-user notification preferences, with categories that can be individually
turned off, except escalations for team leaders.

There is **no email in the system.** No password reset emails, no digests, no
invites.

## 10. Authentication and accounts

- Sign-in with email and password.
- **Two-factor (TOTP) is required for admin, team leader and nurse accounts, and
  optional for support workers.** Enrolment is in-app via QR code, with
  single-use recovery codes shown once at enrolment.
- After first sign-in on a device, biometric unlock (Face ID, fingerprint)
  reopens the app. Biometrics unlock a locally stored refresh token, they are
  not an authentication factor by themselves.
- Sessions expire after a configurable inactivity period (default 12 hours on
  mobile, 1 hour on web).
- **Accounts are created by admins**, who set an initial password and hand it
  over directly. The user must change it at first sign-in.
- **Password reset is an admin action.** There is no self-service reset, because
  there is no email. This is documented as a deliberate trade-off in doc 10.
- Account lockout after repeated failed attempts, cleared by an admin or by
  time.
- Admins can suspend an account instantly, which kills all its sessions and
  wipes the local database on that user's devices at next contact.

## 11. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Offline | Every field action (view assigned participants, read care plans and emergency info, record checks and diary entries, record missed reasons) works with no connection. Sync is automatic and requires no user action. |
| Sync latency | Queued items upload within 30 seconds of connectivity returning. |
| Performance | Participant screen interactive in under 1 second from local data. Report generation under 10 seconds for a month of data. |
| Availability | Single VPS, no HA requirement. Target 99 percent. Planned maintenance is acceptable. |
| Accessibility | WCAG 2.1 AA. Minimum 44px touch targets, works at 200 percent text size, screen reader labels on every control. Staff use this in poor light with gloved hands. |
| Data volume | Design for 200 participants at 12 windows a day plus diary entries, roughly 1 million check entries and 5 million field values per year. |
| Timezone | One org-wide timezone, set in admin settings, changeable. All timestamps stored UTC. |
| Retention | 7 years minimum for participant records (NDIS), then archival, never silent deletion. |
| Browsers | Current Chrome, Edge, Firefox and Safari. No IE, no legacy Edge. |
| Devices | Android 9 and above, iOS 15 and above. |
| Language | English (Australian) only in v1. Strings externalised so translation is possible later. |

## 12. Explicitly out of scope

Recorded so a future build session does not add them speculatively:

- Shift rostering, clock in/out, timesheets, availability, leave.
- Billing, invoicing, NDIS claiming, price guide, service agreements.
- Multi-tenancy. One organisation per deployment.
- Normal ranges, clinical thresholds, early warning scores, any value-based
  alerting.
- NDIS Commission reportable-incident workflow and restrictive practice register.
- AI features of any kind.
- Email, SMS, in-app chat or messaging between staff.
- Family or next-of-kin logins. Participants get self-access, families do not.
- Houses, sites or location grouping.
- Integrations with other systems (calendar, accounting, MyGov, PRODA).
