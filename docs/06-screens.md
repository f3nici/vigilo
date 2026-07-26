# 06. Screens

One codebase serves web and mobile. Layout adapts, information does not change.
Mobile is the primary design target for worker screens because that is where the
work happens. Admin screens are designed for desktop and are usable but not
optimised on a phone.

## 1. Navigation

**Worker and nurse on mobile:** bottom tab bar.

```
[ Today ]  [ Participants ]  [ Diary ]  [ Me ]
```

**Admin and team leader on web:** left sidebar.

```
Dashboard · Participants · Checks · Diary · Reports · Users · Settings · Audit
```

The sync status indicator is always visible: top-right on mobile, in the sidebar
footer on web.

## 2. Auth

| Screen | Contents |
| --- | --- |
| Sign in | Email, password, org logo. Error messages never reveal whether an account exists |
| TOTP challenge | 6-digit code, "use a recovery code instead" link |
| Force password change | Shown when `must_change_password`, cannot be skipped |
| Biometric unlock | App reopen on native. Falls back to password. "Use password instead" always available |
| TOTP enrolment | QR code, manual key, verification, then recovery codes shown once with an explicit "I have saved these" confirmation |

## 3. Today (worker home)

The single most important screen. Answers "what do I need to do right now"
without a network.

```
┌──────────────────────────────────────────┐
│ Today            Tue 26 Jul   ● Synced   │
├──────────────────────────────────────────┤
│ ⚠ NEEDS ATTENTION                        │
│ ┌──────────────────────────────────────┐ │
│ │ A. Smith · 06:00-08:00 window missed │ │
│ │ Tap to record a reason               │ │
│ └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│ DUE NOW                                  │
│ ┌──────────────────────────────────────┐ │
│ │ A. Smith                             │ │
│ │ 2-hourly obs · closes 10:00 (34 min) │ │
│ │ ▓▓▓▓▓▓▓░░░  3 of 5 fields     [Open] │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ LATER TODAY                              │
│ │ A. Smith  10:00-12:00  Not started   │ │
│ │ J. Nguyen 11:00-13:00  Not started   │ │
│ │ A. Smith  12:00-14:00  Not expected  │ │  ← greyed, family supporting
│                                          │
│ DONE                                     │
│ │ A. Smith  04:00-06:00  ✓ 05:51       │ │
└──────────────────────────────────────────┘
```

Rules:
- Missed windows needing a reason sit at the top and stay there until resolved.
- `not_expected` windows are shown greyed with the coverage reason, so the record
  visibly accounts for the gap rather than hiding it.
- Partial windows show a progress bar with fields completed.
- Everything on this screen renders from the local database.

## 4. Participant screens

### 4.1 Participant list
Search and filter, card per participant with photo, preferred name, next check
due, and a count of anything needing attention. Workers see only assigned
participants, with temporary grants badged and showing time remaining.

### 4.2 Participant overview

```
┌──────────────────────────────────────────┐
│ ← Alice Smith ("Ali")            [ ⋮ ]   │
│ ┌──────────────────────────────────────┐ │
│ │ 🔴 Anaphylaxis: peanuts. EpiPen in   │ │
│ │    kitchen drawer.                   │ │
│ │ 🟠 Seizure plan in care plan §4      │ │
│ └──────────────────────────────────────┘ │
│ [ Emergency ] [ Care plan ] [ Add diary ]│
├──────────────────────────────────────────┤
│  Timeline   Checks   Diary   Meds   Info │
├──────────────────────────────────────────┤
│ 09:14  Check 08:00-10:00  ✓ complete     │
│        urine 350ml · BiPAP · repositioned│
│ 08:40  Diary · Personal care             │
│        Assisted with shower, good mood…  │
│ 06:00  Check 06:00-08:00  ✗ missed       │
│        Reason: participant asleep        │
└──────────────────────────────────────────┘
```

Alerts are pinned above everything and always visible on every tab for this
participant. Emergency is one tap and works offline.

### 4.3 Check entry

Renders dynamically from the template version schema.

```
┌──────────────────────────────────────────┐
│ ← 2-hourly obs · A. Smith                │
│ Window 08:00-10:00 · closes in 34 min    │
├──────────────────────────────────────────┤
│ Urine output *                           │
│ ┌────────────────────────┐               │
│ │ 350                    │ ml            │
│ └────────────────────────┘               │
│ Since the last check                     │
│                                          │
│ Ventilator mode *                        │
│ ( ) CPAP    (•) BiPAP                    │
│                                          │
│ Suction performed                        │
│ [ Yes ]  ( No )                          │
│                                          │
│ Cares completed                          │
│ [x] Repositioned  [ ] Mouth care         │
│                                          │
│ Comment                                  │
│ ┌──────────────────────────────────────┐ │
│ │                                      │ │
│ └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│ Saved locally 09:14 · will sync          │
│         [ Save and close ]               │
└──────────────────────────────────────────┘
```

Rules:
- Saves locally on every field change. The button closes the screen, it does not
  perform the save, so a worker who walks away mid-entry loses nothing.
- Required fields marked, but partial entry is allowed and expected. The screen
  says how many required fields remain rather than blocking.
- No colour-coding or warning on any value. Vigilo does not judge readings.
- Number fields open a numeric keypad with the unit visible next to the input.
- After the window closes the same screen still opens, with a clear "this window
  closed at 10:00, your entry will be recorded as late" banner.
- Editing an existing entry shows who recorded it and when, and any edit history.

### 4.4 Missed reason

Reason code list from admin config, plus a note box that becomes required for
codes configured that way. Cannot be dismissed without recording something,
though "record later" defers it back to the Needs Attention list.

### 4.5 Diary entry

Category picker (colour chips), body text with OS dictation available from the
keyboard, occurred-at defaulting to now but editable, photo attach with camera
or gallery, and a visible-to-participant toggle with a plain-language label like
"Alice can see this entry".

### 4.6 Emergency

Full-screen, high-contrast, works offline, reachable in one tap. Alerts, ordered
contacts with tap-to-dial, and the emergency plan text.

### 4.7 Care plan
Read view with a table of contents, an unread marker on a newly published
version, and a version history for nurses and admins.

## 5. Admin screens (web)

| Screen | Contents |
| --- | --- |
| Dashboard | Today's compliance across all participants, unresolved missed windows, devices not synced recently, recent incidents |
| Participants | Table, create and edit, archive. Tabs per participant for details, alerts, contacts, emergency plan, assignments, schedules, coverage |
| Assignments | Assign workers, grant temporary access with expiry and reason, see and revoke active grants |
| Check templates | List, versions, and the field builder |
| Field builder | Drag-to-reorder field list, per-field type, label, key, unit, options, required, help text. Live preview of the rendered form beside the editor. Publish action with a diff against the previous version |
| Schedules | Per participant: template, window length, anchor time, active dates |
| Coverage | Weekly grid editor for supported hours, plus a list of dated exceptions. Recalculate action with a preview of what would change |
| Diary categories | Label, colour, order, active |
| Missed reason codes | Code, label, requires-note flag, order |
| Users | List, create with a generated one-time password shown once, role, suspend, reset password, view devices, force wipe |
| Reports | Daily PDF generator, trend explorer, compliance report with filters, CSV export |
| Audit log | Filter by actor, participant, action, date. Hash chain verification status |
| Settings | Org name, timezone, retention, window warning and escalation timings, session timeouts, backup status |

### Field builder detail

The builder is where an admin defines what "checks every 2 hours" actually means,
so it deserves care:

- Left: ordered field list, drag to reorder, click to edit.
- Right: the real rendered form, exactly as a worker will see it on a phone,
  updating live.
- Publishing shows a diff (fields added, removed, relabelled) and a warning that
  existing records keep the old version.
- Keys are auto-generated from labels but editable before first publish, then
  locked forever.

## 6. Participant self-access

Deliberately simple, read-only.

| Screen | Contents |
| --- | --- |
| My day | Today's diary entries (visible ones only) and completed checks in plain language |
| My records | Date-range browse of the same |
| My reports | Download the daily PDF for a chosen date |

No staff detail beyond the name of who recorded an entry. No incidents. No
checks marked missed and no compliance data, since that concerns staff
performance rather than the participant's care.

## 7. Cross-cutting UI rules

- **Offline is normal, not an error.** No red banners for being offline. The sync
  indicator states the fact, and the app keeps working.
- **Every timestamp shows the org timezone**, with relative time ("34 min ago")
  alongside absolute time where it helps.
- **Destructive actions confirm** and say what happens, including that the record
  is kept for audit.
- **Edited records show an "edited" marker** with one-tap access to history.
  Never quietly replace a clinical value.
- **Touch targets minimum 44px**, tested at 200 percent system text size, with a
  high-contrast mode. Staff use this in dim rooms, sometimes with gloves.
- **No infinite scroll on clinical history.** Explicit date ranges, so a person
  can state what period they looked at.
