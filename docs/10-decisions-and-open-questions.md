# 10. Decisions, assumptions and open questions

## 1. Locked decisions

Confirmed by the owner during planning on 2026-07-26. Do not revisit without an
explicit instruction.

| # | Decision | Notes |
| --- | --- | --- |
| D1 | Brand new project, not an extension of CareLane | CareLane stays as-is |
| D2 | Single organisation, self-hosted. Not multi-tenant | |
| D3 | Scale target 20 to 200 participants, 30 to 300 staff | Drives Postgres over SQLite |
| D4 | Cloud VPS the owner manages, Australian region | |
| D5 | Capacitor for Android and iOS, one web codebase | Proven on this machine with carelane-android |
| D6 | Public App Store and Play Store release | Not internal distribution |
| D7 | Full offline capture and sync | Non-negotiable, workers are in homes with poor signal |
| D8 | Custom append-only sync, no PowerSync or similar | Rationale in doc 05 §2 |
| D9 | Vue 3 + TypeScript + Vite + Tailwind, Node + TS API, Postgres + Drizzle | Rationale in doc 02 §2 |
| D10 | Roles: admin, team leader, nurse, support worker, participant | No family or next-of-kin role |
| D11 | Workers see assigned participants only, admins and team leaders can grant temporary access with expiry and reason | No self-service break-glass |
| D12 | Checks are recorded inside per-participant windows, default 2 hours | Window length varies per participant |
| D13 | Weekly coverage pattern plus dated exceptions determines when checks are expected | Family-supported periods are not counted as missed |
| D14 | **No normal ranges, thresholds or value-based alerting anywhere** | Explicitly rejected. Vigilo records, it does not judge |
| D15 | Entries record who and when, allow partial entry, allow late back-fill, allow editing with full revision history | |
| D16 | Missed windows require a reason code. Overdue windows push-notify the worker, then escalate to the team leader | |
| D17 | Diary: free text with admin-defined categories, photo and file attachments | No structured handover document in v1 |
| D18 | Medications, care plans, incidents and emergency contacts are all in scope, after the core | Phases 7 and 8 |
| D19 | Check field types: number with unit, boolean, checklist, single choice, multi choice, text, date, time, datetime | |
| D20 | Reports: daily PDF, trends, compliance, CSV export | |
| D21 | Encryption at rest, append-only audit log, TOTP, Australian residency, 7-year retention | |
| D22 | NDIS disability sector. Terminology is "participant" | |
| D23 | **No NDIS Commission reportable-incident workflow, no restrictive practice register, no plan or funding tracking** | Handled outside Vigilo |
| D24 | No AI features in v1 | |
| D25 | Native push via FCM and APNs | |
| D26 | Email and password sign-in, biometric unlock after first sign-in | |
| D27 | Participants are independent. No houses, sites or groups | |
| D28 | Phased build, core first. v1 = web + Android with auth, participants, checks, diary, offline sync | |
| D29 | Org-wide configurable timezone, not per participant or per user | |
| D30 | Custom brand for Vigilo, not Catppuccin | Public store presence |
| D31 | Attachments encrypted on the VPS disk, behind a storage interface | Object storage later without schema change |
| D32 | **No transactional email.** Admins issue credentials and reset passwords directly | |
| D33 | Product name is Vigilo | Subject to the availability checks in doc 08 §1 |

## 2. Assumptions made while writing these documents

Each of these was not explicitly stated. They are the most likely reading, and
each is cheap to change now and expensive to change after Phase 3. **Confirm
before Phase 1.**

| # | Assumption | Why | If wrong |
| --- | --- | --- | --- |
| A1 | TOTP is required for admin, team leader and nurse, optional for workers | The owner asked for 2FA but also for a simple email-and-password worker sign-in. Forcing TOTP on 300 field staff with no email recovery would generate constant lockouts | Change the role list in one config value |
| A2 | Team leaders and nurses have a scoped participant list, not global access | Otherwise the role is identical to admin | Small schema change (`team_scopes`) |
| A3 | Nurses can author care plans and templates but not manage users | Clinical authority without administrative authority | Permission matrix change |
| A4 | A participant can have several concurrent check schedules | e.g. 2-hourly vent obs plus daily weight | Removing this simplifies the model |
| A5 | Windows are generated on a fixed grid from an anchor time, not rolling from the last entry | "2 hour window" reads as a fixed window, and rolling windows cannot be materialised in advance for offline use | Significant redesign of the window model. **Confirm this one first** |
| A6 | Late back-fill is allowed up to 24 hours, then needs a team leader | Prevents indefinite retrospective record creation | Config value |
| A7 | View events are audit-logged, batched to one row per user per participant per 15 minutes | Full per-request view logging would dwarf the clinical data | Config value |
| A8 | Numeric check values stay unencrypted so trends and compliance are plain SQL | Doc 03 §6 Option A | Option B needs a reporting table and a refresh job |
| A9 | Diary search is per participant on decrypted data, not org-wide full text | Encrypted bodies cannot use Postgres full text | Needs a separate encrypted search index |
| A10 | Devices hold 7 days back and forward of windows, 30 days of entries | Bounds local database size and bootstrap cost | Config values |
| A11 | Participants cannot see incidents or their own missed-check compliance | Compliance concerns staff performance, and incident narratives often involve third parties | Visibility rule change |
| A12 | Attachments are capped at 20 MB, images and PDF only | | Config |
| A13 | Australian English, single language | | Strings are externalised regardless |
| A14 | One participant is supported by one worker at a time on site | Underpins the low-conflict sync design | Sync conflict handling would need more thought |
| A15 | Push notification payloads carry an initial and surname at most, no clinical content | FCM and APNs are US-operated and the payload leaves Australia | |

## 3. Open questions

Genuinely unresolved. Answer before the phase named.

### Before Phase 0

**Q1. Is the name Vigilo actually available?**
Check `vigilo.com.au` and `vigilo.app`, IP Australia classes 9 and 42, and both
app stores. There are unrelated existing uses of the word. Nothing else can be
branded until this is settled.

**Q2. Which state, and which health records law applies?**
Victoria's Health Records Act 2001 and NSW's HRIPA 2002 impose different duties
on top of the Privacy Act. Doc 07 covers the federal baseline only.

**Q3. Who is the second admin?**
With no email, a sole admin who loses their password and TOTP device locks the
organisation out of its own records. Doc 07 §3 requires at least two admin
accounts plus a documented CLI break-glass. Confirm this is acceptable
operationally.

### Before Phase 3

**Q4. Confirm assumption A5, the window grid model.**
Fixed grid anchored at a time of day ("06:00-08:00, 08:00-10:00") versus rolling
from the last recorded check ("due 2 hours after the last one"). Documents assume
fixed. Rolling windows cannot be pre-generated, which breaks offline recording,
so if rolling is genuinely required the offline design needs rework.

**Q5. What happens to a window that spans a coverage boundary?**
A 2-hour window from 18:00 with coverage ending at 19:00. Is it expected,
not expected, or expected with a shorter effective window? Suggested default:
expected if any part of the window is covered.

**Q6. Can two schedules for the same participant use the same template?**
For example 2-hourly during the day and 4-hourly overnight, same fields. If yes,
schedules need day-of-week and time-of-day applicability, not just active dates.
This is a real scenario in high-acuity care and is worth deciding early.

**Q7. Real examples of the actual check forms.**
The documents use urine output and ventilator mode as stand-ins. Two or three
genuine templates from current paper charts would validate the field type list
and surface anything missing (paired values, running totals, cumulative counts
over a shift).

### Before Phase 5

**Q8. Roughly how many participants will one worker be assigned to?**
Drives local database size and bootstrap cost. Documents assume a handful.

**Q9. Do staff use personal or organisation-owned phones?**
Personal devices change the security posture: no mobile device management, no
enforced OS updates, and a lost phone is outside organisational control. It also
affects what is reasonable to ask (biometrics, forced updates).

### Before Phase 10

**Q10. How does iOS get built and signed?**
There is currently no Mac and no plan. This blocks the App Store entirely. The
realistic options: GitHub Actions macOS runners (works, fiddly signing setup,
free minutes on public repos and paid on private), a cloud Mac service, or buying
a Mac Mini. An Apple Developer Program membership (about 150 AUD a year) is
needed either way. **This is the single biggest gap between the stated goal
(iOS app) and current capability.**

**Q11. Account deletion for App Store guideline 5.1.1(v).**
Apple requires an in-app path to request account deletion. Vigilo accounts are
admin-issued and clinical records are retained for 7 years, which is a legitimate
exception but must be presented correctly. Decide the wording and the in-app flow
before submission, since this is a common rejection.

### Before production

**Q12. Where exactly is the VPS, and who else has access?**
Australian region is a requirement. Confirm the provider's data location, and who
holds root.

**Q13. Where is the master encryption key backed up?**
Losing it means losing every encrypted field, and the backups do not help. This
is the same class of risk as the CareLane signing keystore that exists on this
machine only. Decide on physical, offline storage before the first real record.

**Q14. Who signs off the penetration test?**
Doc 07 §9 requires one before real participant data. Budget and provider unknown.

## 4. Deliberately rejected

Recorded so they are not re-proposed:

- Multi-tenancy, and being a SaaS product for many organisations.
- Family or next-of-kin logins.
- Shift tracking, rostering, timesheets, billing, NDIS claiming.
- Normal ranges, early warning scores, any clinical decision support.
- AI drafting, summarising or transcription.
- Email of any kind.
- Houses, sites or location grouping.
- PowerSync, ElectricSQL, RxDB and other general sync engines.
- React and React Native.
- Server-side SQLite.
