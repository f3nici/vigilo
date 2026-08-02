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
| D41 | **HEIC is refused, though doc 03 §8 lists it.** The app converts to JPEG in the browser before upload | Nothing available server-side decodes HEIC, so its GPS tags could not be stripped, and storing a photo with the participant's home coordinates in it breaks doc 07 §7. Safari can decode HEIC, so the canvas re-encode in the app means an iPhone user never meets the limit. The refusal is the backstop, and it names the iPhone setting to change |
| D42 | **A diary edit writes one revision row per changed field** | Doc 03 §7 sketches one row holding an old and a new body plus an old and a new category. That shape has nowhere to record a changed `occurred_at` or a flipped visibility toggle, both of which change what the record means. Same shape as `check_entry_revisions`, and the old and new values are encrypted together |
| D43 | **A soft-deleted diary entry stays readable by an admin, and is shown marked as deleted** | The row survives for retention, so somebody has to be able to see it. Hiding it from the admin who just deleted it made the delete look like it had failed. Everyone else sees it gone |
| D44 | **Diary search is per participant over decrypted bodies**, confirming A9 option (a) | Doc 03 §7 left this open. An encrypted body cannot feed a tsvector, and the realistic question is "what happened with this person last week". `body_search_tsv` is not in the schema |
| D45 | **Coverage patterns and exceptions are not synced to the device**, though doc 05 §3 lists them | A window arrives with `expected` and `coverageReason` already resolved by the server. Shipping the rules that produced them would give the device a second way to answer a question the server has already answered, and two answers that can disagree is the exact failure CLAUDE.md forbids. Schedules are still synced, because a worker legitimately wants to see what a participant is on |
| D46 | **The back-fill cut-off is measured from the time the worker recorded, not from the time we received it** | A phone in a house with no signal for two days recorded those checks at the time and is only now able to send them. Judging them by server time would refuse exactly the records offline support exists to protect. Device time is trusted for nothing else: lateness still comes from the server clock, and the gap between recorded and received is on the record and visible |
| D47 | **The local database uses the `opfs-sahpool` VFS, so one tab owns it at a time** | The other OPFS backend needs SharedArrayBuffer, which needs cross-origin isolation, which would tax every cross-origin resource for the life of the product. A Web Lock makes the single-owner rule a stated condition, and the second tab is told it is the second tab rather than failing strangely |
| D48 | **An entry pushed with no window that matches no window is rejected, not filed against an invented one** | Doc 05 §6 suggests creating an out-of-schedule entry. A device that could cause a window to exist could cause a schedule to exist, and the fixed admin-configured grid is the whole design. The operation is surfaced on the device as needing attention instead, which is a real thing for an admin to fix: care is being given outside the schedule somebody set |
| D49 | **The last known principal is cached in localStorage** | Without it, a cold start with no signal has nobody to be and the router guard resolves to a blank screen, on a phone that has every record the worker needs already on it. It holds a display name, a role and the org name and timezone, all of which are on screen anyway to whoever is holding the device. Participant data stays in the encrypted local database behind the unlock |
| D50 | **A partial entry does not count as a completed check** | Somebody reading a compliance percentage is asking whether the check was done, and half a set of observations is not a check that was done. Partial is its own column, so nothing is hidden, and the row still adds up to the number scheduled |
| D51 | **A period with nothing scheduled has no compliance percentage, not 100 percent** | Printing 100 for a week nobody was rostered would be a claim nobody made, and it would flatter exactly the periods that deserve a question |
| D52 | **The trend chart is hand-drawn SVG, not a charting library** | Every general-purpose library interpolates across missing data by default, and a line drawn through two days of nothing reads as two days of steady readings. Doc 01 §8.2 requires gaps be shown as gaps, and that is the whole job of the chart |
| D53 | **Reports are admin, team leader and nurse. CSV export is admin only** | A worker records care rather than reporting on it. A CSV is the whole record in a file that can be emailed anywhere, which is a narrower thing than a compliance percentage on a screen |
| D54 | **A CSV field beginning `=`, `+`, `-` or `@` is prefixed with an apostrophe** | A spreadsheet runs those as formulas, and this export is handed to auditors and families. A diary note starting with `=` would otherwise execute when somebody opens the file |
| D55 | **A built export is deleted after 24 hours** | It is decrypted participant data sitting on a volume. Keeping it because somebody might download it again is the wrong trade: they can ask for it again, and until they do it should not exist |
| D56 | **A medication dose has a grace period, held in org settings, default 60 minutes** | A check window has two ends and closes on its own. A dose is a single instant, so without a grace period every dose would be missed the moment it fell due, and the Today screen would be a wall of red by breakfast |
| D57 | **A sign-off carries `reason` and `outcome` as their own encrypted columns**, which doc 03 §9 does not list | Doc 01 §7.2 requires both for a PRN dose. Folding three different things into one note column would make the CSV export and the daily report guess which was which, and a guess about why a medication was given is not a guess software gets to make |
| D58 | **A witness is required only on `given`, and is named by the person signing off rather than authenticating** | The witness exists to put a second pair of eyes on the drug, the dose and the person at handover. A refusal has no handover, and a self-administered dose was not handed over by staff. The name is checked to be an active staff account that is not the recorder, which is what a paper chart's countersignature amounts to. A true co-signature flow, where the witness unlocks the device, is a bigger change than this phase |
| D59 | **A dose is never materialised for a time that has already passed** | A chart set up at 9am, or a due time changed at 11pm, would otherwise produce an 8am dose nobody could have given and the closer marks missed five minutes later. A missed dose says a person did not get their medication, and inventing one for a time before the chart existed blames staff for a dose nobody was ever asked for |
| D60 | **A PRN dose is never late and never counted** | It answers no scheduled time, so there is nothing for it to be late for and nothing it belongs in the denominator of. It is shown on the daily report and exported, and left out of the numbers |
| D61 | **The medication sign-off operation always carries its dose id**, unlike a check entry | A check with no window is bound by timestamp on arrival, because the only question is which hour it belongs to. A dose bound by timestamp would mean guessing which medication was given, and a guess about which drug reached a person is not one software gets to make |
| D62 | **`isPrn` cannot be edited after a medication is created** | Flipping a scheduled medication to PRN strands the doses already materialised against it, and flipping a PRN one to scheduled starts generating doses for a medication whose whole history is ad hoc. Stopping one and starting another says what actually happened |
| D63 | **A care plan body is stored as the author's source text, never as HTML** | Doc 07 §7 names DOMPurify on write and on render as the XSS mitigation. This takes it one step earlier: if no HTML is ever stored there is no stored HTML for a missed sanitiser call to release. `renderCarePlan` in shared escapes every character before emitting a tag and can only emit eight of them, both sides render from that one function, and DOMPurify still runs over its output in the browser as defence in depth |
| D64 | **Publishing a care plan version requires a change summary** | Every assigned worker is notified and shown an unread marker, so somebody is being asked to read it again. "What changed" is the difference between a worker skimming it and a worker finding the paragraph that matters |
| D65 | **Closing an incident requires closure notes** | Doc 03 §9 has the column nullable and it stays nullable for rows that predate this. Closing is the moment somebody says the review is finished, and a closure nobody can read the reasoning for is a closure nobody can review |
| D66 | **An incident carries `involved_enc`**, which doc 03 §9 does not list | Doc 01 §7.3 lists "who was involved" as a field. It is free text rather than a list of user ids because the people involved include family, visitors and passers-by who have no account |
| D67 | **Incidents are never held on a device** | Doc 05 §3 lists what flows to a phone and incidents are not on it. Raising one needs the detail a person types sitting down afterwards rather than standing in a hallway, and an incident narrative is the most sensitive text in the product to leave on a device that can be lost |
| D68 | **An incident can be closed with follow-up actions outstanding, and the count is stated** | An action due next month is not a reason to keep a review open. The number appears in the close response, on screen and on the PDF, so closing a review never hides that something is still owed |
| D69 | **The participant list and record read from the device first** | Added in Phase 8 rather than Phase 5, because the browser walkthrough showed a care plan that was synced, sealed and unreachable: both screens went straight to the API. Doc 01 §7.4 calls the emergency panel the one thing that must never need a network, and it was behind the same wall. The device holds no administrative detail, so the Info tab says that plainly instead of showing convincing blanks |
| D70 | **A self-access account reaches `/auth` and three `/me` paths, and nothing else**, enforced by one allow-list above every router | A participant is in scope for their own record, so `assertInScope` passes for them on every route that takes their id, and every one of those serves a staff DTO. Guarding each would work until the next phase adds the eleventh, and the cost of forgetting is a person reading something written about them that was never meant for them. A route added later is refused by default and has to be named to be reachable |
| D71 | **The self-access DTOs are built field by field, never a staff DTO with fields removed** | A filtered copy inherits whatever is added to the original. `MyDay` can only carry what it declares, so a field added to a check window in a later phase cannot arrive on a participant's screen by inheritance. The Zod schemas strip anything else on the way out |
| D72 | **A participant sees checks that hold a record, and never a missed or pending one** | Doc 06 §6 keeps missed checks out of self-access: they are about whether staff did what the schedule asked, not about the person's care. `partial` is included, because a partial check is a real record with real content and what it is missing is a field rather than a fact |
| D73 | **A self-access account keeps nothing on a device and does not sync** | Doc 05's flow table does not list these screens, and the sync feed is scoped by participant rather than by field, so a participant device would pull whole rows including the diary entries staff marked not visible. Their screens read over the network and say so plainly when there is none, which is the one place in the product where offline is not the normal case |
| D74 | **The self-access day and PDF are a different document from the staff daily report** | The staff report accounts for every window including the ones nobody did, because that is what an auditor reads it for. Deriving the participant's copy from it would mean the two disagree the first time somebody adds a field to the staff one, and the direction that disagreement fails in is disclosure |
| D75 | **A read of one's own record is audited like any other view** | Doc 07 §4 logs views and not only writes. It is also the evidence that the right of access under doc 07 §5 was actually served, which is worth more than the audit row costs |
| D76 | **Today, on these screens, is today in the org timezone** | The date comes from the server, not from the device. A phone with a wrong clock, or a participant who has travelled, would otherwise be shown a different day from the one their support team is looking at |
| D77 | **High contrast is a preference on its own axis, not a fourth theme** | Doc 06 §7 asks for a high-contrast mode. Somebody who needs it needs it at 2am as well as at noon, so it combines with light and dark rather than replacing them. The diary category colours are left alone: they say what an entry is about, never how serious it is, and making them shout would turn a filing label into a severity scale |
| D78 | **A primary action is never greyed out for missing input.** The button works, and pressing it says what is needed and puts the cursor there | A disabled button gives no reason and cannot be asked for one. Somebody pressed "New check form" with no name typed and nothing happened at all, which reads as the app being broken rather than as a form being incomplete. `busy` is still a fair reason to disable, because the button genuinely does nothing while a request is in flight. `useFormGuard` in `packages/app/src/lib/forms.ts` is the one implementation, so every form complains in the same words and in field order |
| D79 | **A number field's unit is optional** | Plenty of what a support team counts has no unit: repositions, seizures, times offered a drink. Requiring one produced fields labelled "Repositions" reading "3 ml". An empty string is still refused, because that is a blank somebody typed into rather than a decision |
| D80 | **A time field can hold several times** | A nebuliser can be given more than once inside one 2-hour window, and each one happened at its own time. Modelling that as several fields means guessing the maximum in advance and leaving the rest blank. Stored as a list in the existing `value_json` column, so nothing about storage changes. Times are held in clock order rather than the order they were typed, because the order they were typed is not a fact about the day |
| D81 | **A check form can carry blocks of guidance that record nothing** | The reference material a worker needs belongs where the decision is made, not in a care plan they have to leave the form to read. An info block is markdown, is typed `required: false` so it can never hold a check open, and never reaches a report, an export or the participant's own record: it is not something anybody recorded. A form made only of guidance is refused, because a window bound to one could never be anything but complete |
| D82 | **One rich text renderer, and it now does tables** | Care plans and info blocks are both prose written for the worker in the room, so they read the same way from the same function. The renderer moved to `richtext.ts` and grew pipe tables, which is what a secretions chart actually is. A table opens only when the next line is the row of dashes, so a plan mentioning "give 2 \| 3 tablets" stays prose. No alignment, because an aligned column means an attribute and this renderer emits none (D63 still holds) |
| D83 | **Publishing a form version is one button with a confirm, not a review step then a button** | The review still happens, at the moment it is useful: as the thing being confirmed. Requiring it first left the publish button greyed out with nothing on screen saying why, which is D78 in the one place where the action is irreversible |
| D84 | **The org timezone comes from `ORG_TIMEZONE`, defaulting to Australia/Perth, and applies only while nobody has edited it** | Every window, every dose and every "daily" boundary is decided in this zone, and it is the only zone staff ever see. The schema default was Melbourne, which is not where this team works, so a 06:00 to 22:00 grid sat two hours off the hours anybody works and the countdown looked like it pointed at the start of a window rather than the end. `updated_at = created_at` is the whole condition: it sets up a fresh deployment and then stops, because an environment variable that quietly overrules a settings screen turns that screen into a lie. The app now reads one `session.timeZone` instead of fifteen hardcoded fallbacks, which were fifteen chances to disagree with the server about what day it is |
| D85 | **A check window is never created for a period that has already closed** | The same rule doses have had since D59. The materialiser lays whole local days, so a schedule saved at 3pm produced a morning of windows nobody could have recorded and the closer marked every one missed within the hour. A missed check says staff did not do something they were asked to do, and nobody was asked for these: the schedule did not exist yet. The window still open is created, because a worker is there and can record it. A test that needs history passes `now` and says when it is pretending to be, rather than reaching around the rule |
| D86 | **24/7 coverage is a tick box that writes the real seven-day pattern, not an empty one** | An empty pattern already behaves as always covered, and that stays true for a participant nobody has configured yet. But an absence is a poor way to state a fact somebody will be asked to defend, and it appeared nowhere on screen. Ticking the box writes seven days of midnight to midnight, so the screen, the audit log and any later recalculation read a decision somebody made rather than inferring one from a gap. Dated exceptions still win over it |
| D87 | **The support team is a tick list, and a purpose-built staff DTO is what makes it usable by a team leader** | Assigning a house of six workers one at a time through a form is how a participant ends up with nobody assigned, and a participant with nobody assigned is one nobody is notified about and nobody can open. Listing accounts is admin-only, which left team leaders able to grant access without being able to see who to grant it to, so `AssignableStaff` carries a name, a role and the state of one tick box and nothing else. Saving the list never ends a temporary grant: those cover a named shift starting shortly, and ending one because somebody was tidying leaves a worker locked out mid-shift. They are reported back and revoked where the reason is visible |

| D88 | **Notifications are removed, and the service worker keeps its listeners** | There is no roster, so there was no honest way to tell a worker on shift from one asleep, and everyone assigned was told at any hour. Rather than ship something that trains people to ignore it, the sending side comes out: the job, the routes, the VAPID config, the web-push dependency and the app's push adapter. The `push` and `notificationclick` handlers stay, because they are the fiddly half (reusing an open window rather than opening a second copy of the app for a worker to lose an entry in), and the three tables stay because nothing in Vigilo hard-deletes and they hold no participant data. A care plan publish now sets the unread marker and nothing else, which is what a worker actually sees when they next open the record |
| D89 | **A check can be recorded with no window behind it** | Every entry hung off a materialised window, so the only way to record anything was for an admin to have scheduled it first, and a worker asked to take a blood pressure had nowhere to put it. `check_entries.window_id` is nullable with a partial unique index, mirroring `medication_administrations.dose_id` for PRN. No window means no lateness and no status. It is **outside the compliance percentage in both directions** and counted beside it: nothing asked for it, so it cannot be a check done on time, and counting it as completed would either push the figure above 100% or hide a missed scheduled check behind an unscheduled one. It has its own array on the daily report rather than a window with the window parts left null, because the safest way to keep it out of `countCompliance` is for it never to be in that array. It reaches a device through the outbox as `check.unscheduled`, and the server never binds a window to one on arrival |
| D90 | **A worker lands on their participants; Today belongs to the roles that ask an across-everyone question** | A worker opens Vigilo to work with a person, and Today asked them to think about windows across a caseload first. The participant list carries what each person still needs, read from the same feed Today reads, so the two cannot disagree, and a missed check owing a reason is on the row rather than waiting for somebody to open the right record. Today stays for admins, team leaders and nurses, refused by route meta rather than merely hidden from the nav. The install `start_url` moves to `/`, which redirects by role, so an installed app does not open on a screen its owner cannot reach |

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
| ~~A9~~ | ~~Diary search is per participant on decrypted data, not org-wide full text~~ | **Confirmed in Phase 4 and now D44.** Option (a) from doc 03 §7: no `body_search_tsv`, search runs after decryption inside one participant's record | n/a |
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
