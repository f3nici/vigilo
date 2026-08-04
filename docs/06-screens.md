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
| Biometric unlock | App reopen. WebAuthn platform authenticator on the PWA, biometric plugin on native. Falls back to password. "Use password instead" always available |
| TOTP enrolment | QR code, manual key, verification, then recovery codes shown once with an explicit "I have saved these" confirmation |

## 2.1 Install (PWA)

Shown to a field user signing in from a plain browser tab. Not a dismissible
nag: without installing, they have no reliable offline storage and no push
notifications on iOS, which means the app cannot do its job.

```
┌──────────────────────────────────────────┐
│              ◍  Vigilo                   │
│                                          │
│  Add Vigilo to your home screen          │
│                                          │
│  You need to install it to:              │
│   ·  Record checks with no signal        │
│   ·  Get reminders when a check is due   │
│   ·  Open it without signing in again    │
│                                          │
│  On iPhone:                              │
│   1. Tap  ⬆︎  Share                       │
│   2. Tap  Add to Home Screen             │
│   3. Open Vigilo from your home screen   │
│                                          │
│         [ Show me ]   [ Not now ]        │
└──────────────────────────────────────────┘
```

- Android and desktop Chromium use `beforeinstallprompt` for a one-tap install.
- iOS has no install API, so it gets illustrated Share-menu instructions. This is
  the single roughest edge of PWA-first and is worth doing properly, including a
  short printable guide for onboarding new staff.
- After install, request `navigator.storage.persist()` and offer WebAuthn unlock
  setup in the same flow.
- Admins working at a desk can dismiss this permanently. Workers get it again at
  next sign-in until they install.

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
│ Monday 3 August                          │
│ 06:00  Check 06:00-08:00  ✗ missed       │
│        Reason: participant asleep        │
│ 08:40  Diary · Personal care             │
│        Assisted with shower, good mood…  │
│ 09:14  Check 08:00-10:00  ✓ complete     │
│        3 of 3 recorded by Ann Smith      │
└──────────────────────────────────────────┘
```

The newest day is at the top and each day reads forwards, from the morning
down (D93). Today is the shift being handed over, and a day is told in the
order it happened. A recorded check names who filled it in.

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
- Number fields open a numeric keypad with the unit visible next to the input,
  and hold the decimal point while it is being typed: a field configured for
  one decimal place has to be able to record 36.4.
- After the window closes the same screen still opens, with a clear "this window
  closed at 10:00, your entry will be recorded as late" banner.
- Editing an existing entry shows who recorded it and when, and any edit history.
- Under the record, the notes an admin has added to it, each with who wrote it
  and when, and the box to add one for an admin (D96). They read as notes about
  the record, never as values on it, and nothing there is coloured.

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
| Field builder | Drag-to-reorder field list, per-field type, label, key, optional unit, options, required, help text, guidance body. Live preview of the rendered form beside the editor. Publish action with a diff against the previous version |
| Schedules | Per participant: template, segments with window length and anchor time, active dates. See the detail below |
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
- A light bulb beside the field picker explains what each field type is for,
  because "Checklist", "One of" and "Several of" cannot be told apart from the
  names alone.
- Publishing is one button (D83). Pressing it shows a diff (fields added,
  removed, relabelled, guidance reworded) and a warning that existing records
  keep the old version, and that is what you confirm. There is no review step
  to complete first.
- The screen says out loud what versioning means: publishing makes this the
  version workers fill in, it cannot be edited afterwards, and editing it later
  starts the next version instead.
- Keys are auto-generated from labels but editable before first publish, then
  locked forever.

### Schedule editor detail

This is where an admin sets up the check grid, so it has to make the resulting
windows obvious rather than something to be inferred from two numbers.

```
┌────────────────────────────────────────────────────────────────┐
│ Alice Smith  ·  Schedule: Vent observations                    │
│ Template: 2-hourly vent obs (v3)          Active from 01/07/26 │
├────────────────────────────────────────────────────────────────┤
│ SEGMENTS                                        [ + Add ]      │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ Daytime      07:00 → 21:00   Every day                     │ │
│ │ Every 2 hours, starting 07:00                       [edit] │ │
│ ├────────────────────────────────────────────────────────────┤ │
│ │ Overnight    21:00 → 07:00   Every day                     │ │
│ │ Every 4 hours, starting 21:00                       [edit] │ │
│ └────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────┤
│ PREVIEW · Monday 27 July                                       │
│  07:00─09:00  09:00─11:00  11:00─13:00  13:00─15:00            │
│  15:00─17:00  17:00─19:00  19:00─21:00                         │
│  21:00─01:00  01:00─05:00  05:00─07:00                         │
│                                                                │
│  ⓘ 10 windows a day. 3 fall outside supported hours and will   │
│    show as not expected (Sun, and weekdays after 19:00).       │
├────────────────────────────────────────────────────────────────┤
│                              [ Cancel ]  [ Save schedule ]     │
└────────────────────────────────────────────────────────────────┘
```

Rules for this screen:

- **The preview is not optional and updates live.** An admin sets a window length
  and an anchor and immediately sees the actual clock times that result.
- The preview overlays coverage, so windows that will land outside supported
  hours are shown greyed with the reason. Setting up a schedule and setting up
  coverage are separate jobs, and this is where they visibly meet.
- Warnings, not blocks, for a gap between segments, an uneven division (a 10pm to
  7am span on a 4-hour window leaves a 1-hour tail), or an anchor that does not
  line up with the segment start.
- Overlapping segments are a hard error and cannot be saved.
- Saving a live schedule shows what changes: how many future windows are
  regenerated, and explicitly that past windows and anything already holding an
  entry are untouched.
- A simple case stays simple. One segment, all day, every day, two fields to
  fill in. Segments only appear as a concept when an admin adds a second one.

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
- **A worker's home is the participant list** (D90). Each row carries what that
  person still needs, and a check owing a reason is named on the row. Today is
  the across-everyone view and belongs to admins, team leaders and nurses.
  Opening a participant leads with what to do now: anything owing a reason,
  anything open, then Record a check, Write in the diary and Medication. The
  record is underneath.
- **A primary action is never greyed out for missing input** (D78). The button
  works. Pressing it with something missing highlights the field, says what is
  needed in one sentence, and moves focus there. Only a request in flight
  disables a button. One implementation, `useFormGuard`, so every form in the
  app complains in the same way and in the order the fields appear.
- **Never interrupt an entry in progress.** A service worker update, a session
  warning or an install prompt waits until the current form is saved. Losing
  half-typed observations to a UI event is the fastest way to lose staff trust.
- **The app looks the same installed or in a tab**, but a tab shows a persistent
  "not installed, records may not be saved offline" strip for field roles.
