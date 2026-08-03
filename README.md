# Vigilo

Self-hosted care records for a disability support team. Participant diaries and
admin-defined observation checks, working offline on a phone in a house with no
signal.

One organisation runs one instance. Support workers install it to their home
screen, open the people they are assigned to, record observation checks inside
recurring time windows, sign off medication and keep the diary. Admins decide
what a check contains, when it is expected, and who can see what.

**It is not a rostering, timesheet or billing system, and it does no clinical
judgement.** Vigilo records values; it never scores, flags or ranges them.

![The participant list](docs/screenshots/participants.png)

---

## Contents

- [Screens](#screens)
- [Deploying](#deploying)
- [Configuration](#configuration)
- [Managing accounts](#managing-accounts)
- [Upgrading](#upgrading)
- [Backups and the master key](#backups-and-the-master-key)
- [Troubleshooting](#troubleshooting)
- [Developing](#developing)
- [Documents](#documents)

---

## Screens

A participant's record: alerts pinned above everything, then the tabs.

![A participant record](docs/screenshots/participant-record.png)

The diary is a day book. It opens on the month with a marker on every day that
has something on, and shows what is on for the day you pick. Entries can be
dated ahead, because writing down what somebody has coming up is the point of
it.

![The diary calendar](docs/screenshots/diary-calendar.png)

An admin ticks which check forms apply to each person, so a worker recording a
check on demand is offered those and nothing else.

![Choosing which check forms apply](docs/screenshots/participant-forms.png)

It is built for a phone first. Everything works at 390px.

<img src="docs/screenshots/diary-mobile.png" alt="The diary on a phone" width="360">

---

## Deploying

You need Docker with the Compose plugin, and a host that terminates TLS.

```bash
git clone https://github.com/f3nici/vigilo.git
cd vigilo
cp .env.example .env
```

Generate a master key and put it in `.env`:

```bash
openssl rand -base64 32
```

> **Read this before going further.** `MASTER_KEY` wraps every per-table data
> key. Lose it and the database is unreadable, and the backups do not help,
> because they are encrypted with it too. Back it up somewhere separate and
> offline before entering a single real record.

Pin the release you want in `.env`:

```bash
TAG=v1.0.0        # or `latest` to follow the default branch
```

Then start it:

```bash
docker compose up -d
```

Nothing is built. Compose pulls `f3nici/vigilo-api` and `f3nici/vigilo-web` from
Docker Hub, and the API runs its own migrations on boot. Check it came up:

```bash
curl localhost:8081/api/ready
# {"status":"ready","build":"...","checks":{"database":true,"migrations":true}}
```

Create the first admin ([details below](#managing-accounts)):

```bash
docker compose exec api npm run admin -- admin:create \
  --email you@example.org --name "Your Name" --role admin
```

That prints a one-time password, once. Sign in with it at
`http://localhost:8081`, change it, and enrol two-factor.

### TLS is not optional

A service worker will not register over plain HTTP, so **there is no offline app
at all without a valid certificate**, which is the whole reason this product
exists. Put nginx, Caddy or a tunnel in front, terminate TLS there, and set:

```bash
SESSION_COOKIE_SECURE=true
CORS_ORIGINS=https://vigilo.your-domain.org,https://localhost
```

Keep `https://localhost` in the list. It is the origin the native builds sign in
from, and leaving it out means native sign-in fails silently later.

---

## Configuration

All of it is environment variables in `.env`. The ones that matter:

| Variable | Default | What it does |
| --- | --- | --- |
| `MASTER_KEY` | *(none)* | **Required.** Wraps the per-table data keys. The API refuses to start without it. Rotate with `1:<old>,2:<new>`. |
| `TAG` | `latest` | Which published image to run. Pin a release on anything real. |
| `IMAGE_PREFIX` | `docker.io/f3nici/vigilo` | Where to pull from. |
| `WEB_PORT` | `8081` | Host port for the web container. |
| `ORG_TIMEZONE` | `Australia/Perth` | IANA name. Every window, dose and "daily" figure is decided in it, and it is the only zone staff ever see. Applied on first run only, then the product owns it. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `vigilo` | Database owner. Migrations run as this. |
| `APP_DB_ROLE` / `APP_DB_PASSWORD` | `vigilo_app` | The restricted role the API actually serves as. It has no `UPDATE` or `DELETE` on the audit log. |
| `CORS_ORIGINS` | `http://localhost:8081,https://localhost` | Comma-separated allow-list. |
| `SESSION_COOKIE_SECURE` | `false` | Set `true` in production. |
| `SESSION_SAMESITE` | `lax` | Set `none` once native builds exist, or native sign-in fails silently. |
| `ATTACHMENT_DIR` | `/data/attachments` | Attachment bytes inside the container. Use an encrypted volume in production. |
| `LOG_LEVEL` | `info` | |

A blank value is not an absent value: `docker compose` passes `${VAR:-}` as an
empty string, so the config layer treats blank as unset on purpose. Deleting a
line and blanking a line mean the same thing.

---

## Managing accounts

There is **no password reset email and no account recovery endpoint**, by
design. Recovery is a CLI on the host, it audits every invocation, and it cannot
read participant data.

Every command runs inside the API container:

```bash
docker compose exec api npm run admin -- <command> [flags]
```

### Create an account

```bash
docker compose exec api npm run admin -- admin:create \
  --email jo@example.org --name "Jo Smith" --role worker
```

Roles: `admin`, `team_leader`, `nurse`, `worker`. Prints a one-time password
that is shown once and never stored in plaintext. The account must change it at
first sign-in, and admins, team leaders and nurses must then enrol TOTP.

### Reset a password

```bash
docker compose exec api npm run admin -- admin:reset-password \
  --email jo@example.org --confirm
```

Prints a new one-time password. The old one stops working immediately.

### Somebody lost their phone

Their TOTP was on it, and so were their recovery codes if they never wrote them
down.

```bash
docker compose exec api npm run admin -- admin:disable-totp \
  --email jo@example.org --confirm
```

They sign in with their password and are walked through enrolment again on a new
device.

### Somebody is locked out after too many attempts

```bash
docker compose exec api npm run admin -- admin:unlock --email jo@example.org
```

### Sign a person out everywhere

For a lost or stolen device, or somebody leaving.

```bash
docker compose exec api npm run admin -- admin:revoke-sessions \
  --email jo@example.org --confirm
```

Every session and refresh token for that account stops working at once. Records
already on their device stay on their device until it next reaches the server,
which is the trade an offline-first app makes.

### List the admin accounts

```bash
docker compose exec api npm run admin -- admin:list
```

It warns when there is only one, which is worth heeding: a single admin who
loses their phone and their recovery codes is a restore from backup.

### Verify the audit chain

The audit log is append-only and hash-chained. This walks it and says whether any
row was altered or removed underneath the application.

```bash
docker compose exec api npm run admin -- audit:verify
# Audit chain intact across 38 rows.
```

Worth running on a schedule, and worth running before any compliance
conversation.

---

## Upgrading

```bash
# Pin the new release in .env, then:
docker compose pull
docker compose up -d
```

The API runs pending migrations on boot, before it serves anything. Take a
database backup first (below): migrations are not reversible, and nothing here
is hard-deleted, so rolling back means restoring.

Staff get the new front end on their next visit. An installed app holds its
service worker until the update is safe to apply. It never reloads underneath
somebody half way through recording, so a worker sees "a new version is ready"
and applies it when they are not mid-entry.

### Publishing a build

The **Release** workflow builds and publishes both images under a tag you type.
Actions → Release → Run workflow, then fill in:

| Input | Meaning |
| --- | --- |
| `tag` | The tag to publish, e.g. `v1.4.0`. Letters, numbers, dot, dash, underscore. |
| `latest` | Whether to move `latest` to this build. On by default. |
| `skip_checks` | Publish without running the suite. Emergencies only. |

It runs the full test suite, builds `api` and `web`, pushes them, then starts the
published images and smoke tests them before calling it done. The run summary
tells you exactly what to put in `.env`.

Every branch push already publishes images tagged with the branch name and the
commit sha, so any branch can be pulled and run without tagging a release.

---

## Backups and the master key

Two things to back up, and they must be kept apart.

**1. The database.**

```bash
docker compose exec -T db pg_dump -U vigilo vigilo | gzip > vigilo-$(date +%F).sql.gz
```

**2. The attachment volume.** Photos and built exports live there, encrypted
under their own keys.

```bash
docker run --rm -v vigilo_attachment-data:/data -v "$PWD":/out alpine \
  tar czf /out/vigilo-attachments-$(date +%F).tar.gz -C /data .
```

**And `MASTER_KEY`, stored somewhere else entirely.** A backup and the key that
decrypts it in the same place is one theft, not two. Restoring the database
without the key gives you a lot of ciphertext and nothing else.

Restore is the reverse, into a stack that is not serving:

```bash
docker compose down
docker compose up -d db
gunzip -c vigilo-2026-08-04.sql.gz | docker compose exec -T db psql -U vigilo vigilo
docker compose up -d
```

---

## Troubleshooting

**`api` will not start and the logs mention the master key.** It is required,
and blank counts as missing. Generate one with `openssl rand -base64 32`.

**The app shows an old version after a deploy.** The service worker is serving
its precached bundle, which is what it is for. The app offers the update; take
it. To force it in a browser: DevTools → Application → Service Workers →
Unregister, then reload. `index.html` and `sw.js` are served `no-store` and the
worker revalidates from the network, so this is the worker holding back
deliberately rather than a cache to go hunting for.

**A worker's screen is empty and says the device cleared its records.** iOS can
evict storage after about seven days of not opening the app. Nothing that had
synced is lost; it downloads again. Anything still in the outbox at the time is
gone, which is why the app asks to be installed and shows outbox depth.

**Photos fail on the first upload with a permissions error.** The attachment
volume mounted root-owned and the container runs as `node`. Fix ownership on the
volume. The image creates the directory correctly, so this only happens to a
volume made some other way.

**`npm run admin` says the command was not found.** Put `--` before the
subcommand: `npm run admin -- admin:list`.

---

## Developing

Node 22 and Docker.

```bash
npm ci
cp .env.example .env       # add a MASTER_KEY

# Build from source instead of pulling:
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

```bash
npm test          # all three workspaces
npm run typecheck
npm run lint
npm run format
```

The API tests need a Postgres of their own:

```bash
docker run -d --name vigilo-test-db \
  -e POSTGRES_USER=vigilo -e POSTGRES_PASSWORD=vigilo -e POSTGRES_DB=vigilo_test \
  -p 5432:5432 postgres:17
```

They read `TEST_DATABASE_URL`, defaulting to
`postgres://vigilo:vigilo@localhost:5432/vigilo_test`.

### Layout

```
packages/shared   types, Zod schemas, window/coverage/completeness logic. No I/O.
packages/api      Express 5 + Drizzle + Postgres.
packages/app      Vue 3 SPA + service worker.
                  platform/web    = SQLite-WASM over OPFS, WebAuthn
                  platform/native = Capacitor SQLite, Keychain (final phases)
```

Shared logic lives in `packages/shared` because the API and the device both
decide window state, coverage and completeness. If the two can disagree, it is a
bug.

`CLAUDE.md` holds the working rules for this repo, and
[docs/10](docs/10-decisions-and-open-questions.md) is the authority on what is
locked. Read the hard rules in both before changing behaviour.

---

## Documents

Read in order. Each assumes the ones before it.

| Doc | Contents |
| --- | --- |
| [01](docs/01-product-requirements.md) | What the product does, users, roles, every feature and its rules |
| [02](docs/02-architecture.md) | Stack, why each choice was made, deployment, environments |
| [03](docs/03-data-model.md) | Every table, column and relationship, with the encryption strategy |
| [04](docs/04-api.md) | REST surface, auth flow, error shape, pagination |
| [05](docs/05-offline-sync.md) | The offline sync design. Read before touching anything sync-related |
| [06](docs/06-screens.md) | Every screen and what it shows |
| [07](docs/07-security-compliance.md) | Encryption, audit, retention, threat model, store requirements |
| [08](docs/08-brand.md) | Name, palette, typography, UI rules, app icon |
| [09](docs/09-roadmap.md) | Phased build plan with acceptance criteria per phase |
| [10](docs/10-decisions-and-open-questions.md) | Locked decisions, assumptions made, questions still open |

### Decisions worth knowing before reading the code

- Single organisation, self-hosted. Not multi-tenant, never SaaS.
- **No normal ranges, thresholds or clinical alerting.** Anywhere. Colour says
  record state, never whether a value is good or bad.
- Checks sit on a **fixed, admin-configured window grid**, default 2 hours, with
  segments for different intervals by time of day. It never rolls forward from
  the last recorded check.
- Workers see only assigned participants. Admins can grant temporary access, and
  a temporary grant needs both an expiry and a reason.
- Nothing is hard-deleted while retention applies. Soft delete or archive.
- **No email of any kind.** Admins issue credentials; recovery is the CLI above.
- **Installable PWA is v1.** Capacitor native builds are the last two phases.
- Roles: admin, team leader, nurse, support worker, participant.

Full detail and rationale in
[docs/10](docs/10-decisions-and-open-questions.md).

---

## Status

Phases 0 to 9 are built: identity with TOTP and the break-glass CLI, the scope
resolver, the audit log and the encryption layer; participants with alerts,
emergency contacts and assignments; check templates, schedules, coverage and
entry recording; the installable PWA with a local SQLite database, offline
unlock and the revision-cursor sync; reports and audited CSV export; the
medication administration record; care plans and incidents; and participant
self-access.

**Phase 10 is production hardening, and it must complete before real participant
data is entered.** See [the roadmap](docs/09-roadmap.md).

Not a public product. It is built for one organisation and self-hosted by them.
