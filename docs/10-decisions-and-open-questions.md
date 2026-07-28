# 10. Decisions, assumptions and open questions

## 1. Locked decisions

Confirmed by the owner during planning on 2026-07-26. Do not revisit without an
explicit instruction. D34 to D36 were added later the same day and supersede the
parts of D5, D6 and D28 they touch.

| # | Decision | Notes |
| --- | --- | --- |
| D1 | Brand new project, not an extension of CareLane | CareLane stays as-is |
| D2 | Single organisation, self-hosted. Not multi-tenant | |
| D3 | Scale target 20 to 200 participants, 30 to 300 staff | Drives Postgres over SQLite |
| D4 | Cloud VPS the owner manages, Australian region | |
| D5 | Capacitor for Android and iOS, one web codebase | Proven on this machine with carelane-android. **Superseded in ordering by D34: native builds come last** |
| D6 | Public App Store and Play Store release | Not internal distribution. Still the goal, now the final phases |
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
| D34 | **Ship as an installable PWA first. Native Android and iOS come last** (phases 11 and 12) | The PWA is a complete product on its own: offline recording, local SQLite over OPFS, Web Push, WebAuthn unlock. Native adds store presence, storage iOS cannot evict, and reliable background sync. Doc 01 §13 |
| D35 | **Local storage is SQLite on both platforms**: SQLite-WASM over OPFS in the PWA, Capacitor SQLite natively. Not IndexedDB | One local schema, one set of queries, written once and reused when the native builds arrive. Costs about 1 MB of WASM |
| D36 | **Break-glass admin recovery is a CLI in the API container**, run over `docker compose exec`, audited on every invocation, with no HTTP surface and no access to participant data | The only account recovery path that can exist without email. Resolves the sole-locked-out-admin risk. Doc 01 §10.1, doc 02 §9, doc 07 §3 |
| D37 | **A coverage pattern with no ranges at all means always covered** | Set in Phase 3. The other reading, that an unconfigured pattern covers nothing, lets a schedule be built and produce a week of `not_expected` windows without saying why. An admin narrows from "always" rather than opening from "never". Doc 01 §5.4 |
| D38 | **Coverage pattern rows are superseded, not replaced**, keeping `active_from` and `active_to` | So recalculating a past week uses the pattern that applied then. Correcting history is what a dated exception is for, and that records who decided it. Doc 03 §5 |
| D39 | **Filling in the rest of a part-recorded check is the same entry, not an edit** | No revision rows until every required field has a value. After that, any change is a change to a clinical record and is preserved with the old value. Doc 01 §5.5 |
| D40 | **A midnight range end may be written `00:00` or `24:00`** | `<input type="time">` refuses `24:00` outright and renders an empty box, so the picker an admin uses can only produce `00:00`. Both spellings resolve to the same instant |

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
| ~~A5~~ | ~~Windows are generated on a fixed grid from an anchor time~~ | **Confirmed by the owner 2026-07-26. Now a locked decision.** Fixed grid, and an admin configures it per participant with a live preview of the resulting window times. Segmented schedules cover different intervals by time of day. Doc 01 §5.3, doc 03 §5, doc 06 §5 | n/a |
| A6 | Late back-fill is allowed up to 24 hours, then needs a team leader | Prevents indefinite retrospective record creation | Config value |
| A7 | View events are audit-logged, batched to one row per user per participant per 15 minutes | Full per-request view logging would dwarf the clinical data | Config value |
| A8 | Numeric check values stay unencrypted so trends and compliance are plain SQL | Doc 03 §6 Option A | Option B needs a reporting table and a refresh job |
| A9 | Diary search is per participant on decrypted data, not org-wide full text | Encrypted bodies cannot use Postgres full text | Needs a separate encrypted search index |
| A10 | Devices hold 7 days back and forward of windows, 30 days of entries | Bounds local database size and bootstrap cost | Config values |
| A11 | Participants cannot see incidents or their own missed-check compliance | Compliance concerns staff performance, and incident narratives often involve third parties | Visibility rule change |
| A12 | Attachments are capped at 20 MB, images and PDF only | | Config |
| A13 | Australian English, single language | | Strings are externalised regardless |
| A14 | One participant is supported by one worker at a time on site | Underpins the low-conflict sync design | Sync conflict handling would need more thought |
| A15 | Push notification payloads carry an initial and surname at most, no clinical content | Push relays are overseas. Web Push payloads are end-to-end encrypted, FCM and APNs payloads are not | |
| A16 | Field staff will install the PWA to their home screen, and will be shown how | Without installing there is no reliable offline storage and no push on iOS. Onboarding needs a short printed guide | If staff will not install, the native phases move up the roadmap and become urgent rather than optional |
| A17 | Staff phones run Android with Chrome 108+ or iOS with Safari 17+ | The floor for OPFS and installed-PWA Web Push | Older devices need the native build, or lose offline mode |
| A18 | A worker on a plain browser tab is an office-use case, not a field one | Tabs get no local database and a shorter session | |
| A19 | Losing an outbox to iOS storage eviction is an acceptable v1 risk | Mitigated by aggressive syncing, persisted-storage requests and a visible queue, and eliminated by the native build later | If unacceptable, phase 12 becomes a blocker for iOS staff rather than an improvement |
| A20 | The admin CLI is run by the owner over SSH, not by organisation staff | Shell access is the security boundary | If care staff need to run it, it needs a different design |

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

**Q3. Who is the second admin, and who holds server shell access?** *(partly
resolved)*
Recovery is now a CLI run on the host over `docker compose exec` (D36), so a
locked-out admin is fixable. Two things still need answering: whether there will
be at least two admin accounts so day-to-day lockouts do not need the server at
all, and **who besides the owner can SSH to the VPS**. Shell access is now the
recovery path, which makes it a single point of failure if only one person has
it and a security concern if too many do.

### Before Phase 3

**~~Q4. Confirm the window grid model.~~** *Resolved 2026-07-26.* Fixed grid,
admin-configured per participant, with segments for different intervals by time
of day and a live preview of the resulting window times before saving. See D34
and doc 01 §5.3.

**~~Q5. What happens to a window that spans a coverage boundary?~~**
*Resolved 2026-07-27, taking the suggested default.* **Expected if any part of
the window is covered.** A 2-hour window from 18:00 where support ends at 19:00
still has an hour of someone there to record it, and calling it not-expected
would hide a check that could have happened. Coverage ranges are half-open, so
a window starting exactly as support ends is not expected. Implemented in
`resolveCoverage` in `packages/shared/src/coverage.ts` and tested both ways.

**~~Q6. Different intervals at different times of day?~~** *Resolved 2026-07-26
by the segmented schedule model.* One schedule holds several segments, each with
its own window length, anchor and applicable hours and weekdays. 2-hourly by day
and 4-hourly overnight is a two-segment schedule. Doc 03 §5.

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
affects what is reasonable to ask (biometrics, forced updates). It matters more
under PWA-first, because PWA local storage is protected by column encryption
rather than whole-database SQLCipher (doc 07 §2).

**Q15. What phones do staff actually carry?**
Specifically, how many are on iOS below Safari 17 or Android below Chrome 108.
Anyone below the floor cannot use the PWA offline and needs the native build,
which would change the roadmap priority. Worth a quick survey before Phase 5.

**Q16. Will staff reliably install the PWA to their home screen?**
The whole field experience depends on it, and iOS has no install prompt API, only
Share-menu instructions. If the organisation thinks this will not stick, the
native phases move from optional to necessary. Consider testing the install flow
with two or three actual workers before committing to the sequencing.

### Before Phases 11 and 12 (native)

**Q10. How does iOS get built and signed?**
There is currently no Mac and no plan. The realistic options: GitHub Actions
macOS runners (works, fiddly signing setup, free minutes on public repos and paid
on private), a cloud Mac service, or buying a Mac Mini. An Apple Developer
Program membership (about 150 AUD a year) is needed either way. **PWA-first
removes this from the critical path**, since iOS staff get a working installed
app with push in Phase 5, but it still blocks store presence and durable
storage on iOS.

**Q11. Account deletion for App Store guideline 5.1.1(v).**
Apple requires an in-app path to request account deletion. Vigilo accounts are
admin-issued and clinical records are retained for 7 years, which is a legitimate
exception but must be presented correctly. Decide the wording and the in-app flow
before submission, since this is a common rejection. Not relevant to the PWA.

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
- IndexedDB or Dexie as the local store, in favour of SQLite on both platforms.
- Native apps first. They are the final phases, not the starting point.
- Any HTTP endpoint for break-glass account recovery. It is a host CLI only.
