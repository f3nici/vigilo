# Vigilo

Care records platform for a disability support team. Participant diaries and
admin-defined observation checks, on web, Android and iOS, working offline.

Status: **planning only.** No code has been written yet. This repository
currently holds the documents a build session needs to implement the product.

## What it is

A single organisation runs one self-hosted instance. Support workers install the
app to their phone's home screen, see the participants they are assigned to,
record observation checks inside recurring time windows (typically every 2
hours), and write diary entries. Admins define what a check contains, when it is
expected, and who can see what. Everything works with no signal and syncs when
the phone gets back online.

**It ships as an installable PWA first.** Native Android and iOS store builds
wrap the same code with Capacitor and are the final phases of the build.

It is not a rostering or shift-tracking system. It does not do billing.

## Documents

Read in order. Each one assumes the ones before it.

| Doc | Contents |
| --- | --- |
| [01-product-requirements.md](docs/01-product-requirements.md) | What the product does, users, roles, every feature and its rules |
| [02-architecture.md](docs/02-architecture.md) | Stack, why each choice was made, deployment, environments |
| [03-data-model.md](docs/03-data-model.md) | Every table, column and relationship, with the encryption strategy |
| [04-api.md](docs/04-api.md) | REST surface, auth flow, error shape, pagination |
| [05-offline-sync.md](docs/05-offline-sync.md) | The offline sync design, the riskiest part of the build |
| [06-screens.md](docs/06-screens.md) | Every screen on web and mobile, and what it shows |
| [07-security-compliance.md](docs/07-security-compliance.md) | Encryption, audit, retention, threat model, store requirements |
| [08-brand.md](docs/08-brand.md) | Name, palette, typography, UI rules, app icon |
| [09-roadmap.md](docs/09-roadmap.md) | Phased build plan with acceptance criteria per phase |
| [10-decisions-and-open-questions.md](docs/10-decisions-and-open-questions.md) | Locked decisions, assumptions made, questions still open |

## Locked decisions (short version)

- Single organisation, self-hosted on a cloud VPS. Not multi-tenant.
- Scale target: 20 to 200 participants, 30 to 300 staff.
- Vue 3 + TypeScript + Vite + Tailwind. Node + TypeScript API, PostgreSQL,
  Drizzle ORM.
- **Installable PWA is v1.** Capacitor native builds are the last two phases.
- Full offline capture and sync, custom append-only design. SQLite on the device
  either way: SQLite-WASM over OPFS in the PWA, native SQLite later.
- Roles: admin, team leader, nurse, support worker, participant.
- Workers see only assigned participants. Admins can grant temporary access.
- Checks sit on a **fixed, admin-configured window grid**, default 2 hours, with
  segments for different intervals by time of day.
- No clinical normal ranges anywhere in the system.
- No AI features in v1.
- No transactional email. Admins issue credentials, and account recovery is a
  **CLI run on the server** over `docker compose exec`.
- iOS store release is still blocked on Mac or CI signing access, but iOS staff
  get a working installed PWA with push at the v1 line regardless.

Full detail and rationale in [10-decisions-and-open-questions.md](docs/10-decisions-and-open-questions.md).
