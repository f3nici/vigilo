# Vigilo — instructions for Claude Code

Care records platform for a disability support team. Participant diaries and
admin-defined observation checks, on web, Android and iOS, working offline.

**Status: planning only. No code exists yet.** Start with Phase 0 in
`docs/09-roadmap.md`.

## Read before building

1. `docs/01-product-requirements.md` — what it does and the rules
2. `docs/02-architecture.md` — stack and why
3. `docs/03-data-model.md` — schema
4. `docs/05-offline-sync.md` — before touching anything sync-related
5. `docs/10-decisions-and-open-questions.md` — what is locked and what is not

`docs/10` is the authority on decisions. If something here contradicts it, doc 10
wins.

## Hard rules

- **No normal ranges, thresholds or clinical alerting.** Ever. Vigilo records
  values, it does not judge them. Reject any schema field or UI treatment that
  implies a value is good or bad. Colour signals record state only.
- **Scope enforcement is centralised.** One resolver maps a principal to the
  participant ids they may touch. Route handlers never assemble access rules
  themselves.
- **Nothing is hard-deleted** while retention applies. Soft delete or archive.
- **The audit log is append-only** and hash-chained. The app database role has no
  UPDATE or DELETE on it. Views are logged, not only writes.
- **Windows are generated server-side only.** Devices never create them.
- **Sync operations are idempotent by client-supplied UUID v7.** Replay must
  never duplicate a clinical record.
- **Shared logic lives in `packages/shared`.** Window state, coverage resolution
  and completeness rules are used by both the API and the device. If the two can
  disagree, it is a bug.
- **No email.** No password reset emails, no digests, no invites. Admins issue
  credentials directly.
- **Nothing sensitive in push payloads.** An initial and surname is the ceiling.
- Australian English in all user-facing strings.

## Workflow

Per the global instructions on this machine:

- Never commit to main. Branch per phase with a descriptive name.
- Tests with the feature, not after.
- Commit, push, `gh pr create`, then `gh run watch` until CI is green.
- Verify web changes in a real browser via the Playwright MCP, and read the
  console before calling it done.
- Verify container changes by pulling and running the built image from Docker
  Hub, not by trusting a green check.
- No em dashes in prose. Comments and commit messages short and factual.

## Layout

```
packages/shared   types, Zod schemas, window/coverage/completeness logic. No I/O.
packages/api      Express 5 + Drizzle + Postgres. routes / services / db / crypto / jobs / sync / reports
packages/app      Vue 3 SPA. views / components / stores / db (local SQLite) / sync / platform
                  android/ and ios/ hold the Capacitor projects
```

## Stack

Vue 3 + TypeScript + Vite + Tailwind + Pinia, wrapped by Capacitor.
Node 22 + TypeScript + Express 5 + Zod + Drizzle + PostgreSQL 17.
SQLCipher SQLite on device. PDFKit for reports. node-cron for jobs.
Vitest for unit and API tests, Playwright for E2E.

## Verifying

```bash
docker compose up --build          # app on :8080, API docs at /api/docs
docker compose run --rm api npm test
```

No Node needed locally, everything runs in Docker, same as the other projects on
this box.

## Watch out for

- Capacitor apps sign in from origin `https://localhost`. The server must
  CORS-allow it and set `SESSION_SAMESITE=none` with valid HTTPS, or native
  sign-in fails silently. This cost time on CareLane, do not repeat it.
- Publishing a check template version is irreversible. Existing entries stay
  bound to the version they were recorded against.
- Coverage recalculation can rewrite compliance history. It must preview before
  applying, and it is heavily audited.
- Never point a store review build at production data. Use staging with seeded
  fake participants.
