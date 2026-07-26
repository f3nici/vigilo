# 08. Brand and design system

## 1. Name

**Vigilo.** Latin, "I keep watch". It names what the product actually does:
regular, attentive observation of someone's wellbeing, recorded honestly.

Pronounced *vij-ill-oh*. Written with a capital V, never all caps in body text,
never "VIGILO".

Chosen partly for searchability. "Care" plus a noun is a saturated category and
would never rank. Vigilo is uncommon enough as a software brand to own its
results.

**Before committing:**
- Check `vigilo.com.au` and `vigilo.app` availability.
- Search IP Australia's trade mark register for Vigilo in class 9 (software) and
  class 42 (SaaS).
- Check the App Store and Play Store for name collisions.
- There are unrelated existing uses of the word (a French network monitoring
  tool among them). Confirm nothing conflicts in the care or health space in
  Australia.

**Tagline options:** "Care, recorded." · "Every check, every note, every time." ·
"The record that keeps up."

## 2. Design principles

1. **Legible before pretty.** This is read in dim bedrooms at 3am by tired people,
   sometimes with gloves on. Contrast and size win every argument.
2. **Calm, not clinical-cold.** These are people's homes, not a hospital ward.
   Warm neutrals rather than sterile white and hospital blue.
3. **Never judge a value.** No red numbers, no warning triangles on readings.
   Vigilo has no normal ranges by design, and the UI must not imply otherwise.
   Colour signals system state (recorded, missed, syncing), never clinical state.
4. **Offline is a state, not an error.** Neutral colour, plain wording.
5. **The record is honest.** Edits show as edits, late shows as late, gaps show
   as gaps. Nothing is prettied up.

## 3. Palette

Built on a warm neutral base with a deep teal primary. Teal reads as trustworthy
and medical-adjacent without being the hospital blue every care product uses.

### Light

| Role | Hex | Use |
| --- | --- | --- |
| Primary | `#0F6E6E` | Actions, active nav, links |
| Primary hover | `#0B5757` | |
| Primary subtle | `#E3F2F1` | Selected rows, chips |
| Surface | `#FFFFFF` | Cards, inputs |
| Background | `#F7F6F3` | Page, warm off-white not grey |
| Border | `#E2E0DA` | |
| Text primary | `#1C1B19` | 15.8:1 on background |
| Text secondary | `#5B5852` | 7.2:1 |
| Text muted | `#8A867E` | 4.6:1, minimum for any text |

### Dark

| Role | Hex |
| --- | --- |
| Primary | `#4FC4C0` |
| Primary subtle | `#12312F` |
| Surface | `#1E1D1B` |
| Background | `#141311` |
| Border | `#33312D` |
| Text primary | `#F2F0EB` |
| Text secondary | `#B0ADA6` |

Dark mode is a real requirement, not a nicety. Overnight checks happen at 2am
next to a sleeping person, and a white screen at full brightness is a problem in
someone's bedroom. Follow the device setting with a manual override.

### Status colours

Used only for record state, never for clinical values.

| State | Light | Dark | Meaning |
| --- | --- | --- | --- |
| Complete | `#2E7D4F` | `#5FBF87` | Check recorded |
| Partial | `#B8790B` | `#E0A83C` | Some fields recorded |
| Pending | `#5B5852` | `#B0ADA6` | Window open, nothing yet |
| Missed | `#B3402F` | `#E8776A` | Expected, not recorded |
| Not expected | `#8A867E` | `#7A766F` | Outside coverage, greyed |
| Late | `#7A4FB8` | `#B79BE8` | Recorded after close |
| Syncing | `#0F6E6E` | `#4FC4C0` | Queued, not an error |

Every status also carries an icon and a text label. Colour is never the only
signal, both for accessibility and because "missed" is too important to encode
in a hue.

**Alert severities** on a participant are the one place stronger colour is
allowed, because an anaphylaxis alert genuinely must shout: critical `#B3402F`
with a filled background, warning `#B8790B`, info neutral.

## 4. Typography

- **UI:** Inter, system sans fallback. Self-hosted, no CDN.
- **Numeric:** Inter with tabular figures for anything in a column of readings.
- **PDF reports:** a serif for body (Source Serif or similar) with sans headings.
  Reports get printed, filed and handed to families, and serif reads better on
  paper.

Scale: 12 / 14 / 16 / 20 / 24 / 32. Body is **16px minimum on mobile** and never
smaller than 14px anywhere. Must remain usable at 200 percent system text size,
which means no fixed-height containers around text.

## 5. Logo and icon

**Wordmark:** "Vigilo" in Inter SemiBold, slightly tightened tracking, with the
dot of the *i* replaced by a small filled circle in primary teal, reading as a
watchful eye and as a recorded data point at the same time.

**App icon:** a single filled circle inside a rounded arc that does not quite
close, on a deep teal ground. The arc suggests a repeating cycle (the 2-hourly
round) and an eye. It works at 48px, which most care-app logos with a heart and
a hand do not.

Avoid: hearts, hands, caduceus, stethoscopes, and any hand-holding imagery. The
category is full of them and none survive being shrunk to a home screen icon.

Required sizes: 1024 (store), 512, 192, 180, 120, 48, plus Android adaptive
foreground and background layers, and a monochrome layer for Android 13 themed
icons.

## 6. Component rules

- **Cards** for records, 8px radius, 1px border, no drop shadows in light mode.
- **Touch targets 44px minimum**, 48px for primary actions.
- **Inputs** at least 48px tall, 16px text to stop iOS zoom on focus, label above
  the field (never placeholder-as-label), unit shown as a suffix inside number
  inputs.
- **Buttons:** one primary per screen. Destructive actions are outlined in the
  missed colour, not filled, so they are never the easiest thing to hit.
- **Empty states** say what to do next, not just "no data".
- **Loading:** skeletons for content, never a full-page spinner. On mobile most
  reads are local and instant, so a spinner usually means something is wrong.
- **Timestamps** always show the org timezone, with relative time as a secondary
  hint.

## 7. Voice

Plain Australian English. Short sentences.

- "Check recorded" not "Observation successfully submitted".
- "No connection. Your entry is saved and will sync." not "Network error".
- "Alice can see this entry" not "Participant visibility: enabled".
- Never blame the user. "This window closed at 10:00. Your entry will be recorded
  as late." states the fact without scolding.
- Australian spelling throughout: organisation, recognised, colour.
