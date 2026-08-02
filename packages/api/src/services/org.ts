import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { orgSettings, type OrgSettings } from '../db/schema.js';

/**
 * Org settings are read on nearly every request (session idle window, and
 * later the timezone every window calculation depends on), and changed rarely
 * by one admin. A short cache keeps that off the hot path without making a
 * settings change feel broken.
 */
const CACHE_TTL_MS = 30_000;

let cached: { value: OrgSettings; at: number } | null = null;

export async function getOrgSettings(db: Database): Promise<OrgSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, 1)).limit(1);
  if (!row) {
    // Migration 0001 seeds it. If it is gone, something is badly wrong and a
    // guessed default would hide it.
    throw new Error('org_settings row 1 is missing');
  }

  cached = { value: row, at: Date.now() };
  return row;
}

/** Called after an update so the next read is fresh. */
export function invalidateOrgSettings(): void {
  cached = null;
}

/**
 * Applies `ORG_TIMEZONE` to a settings row nobody has ever edited (D84).
 *
 * Run once at startup, after migrations. It is how a fresh deployment gets the
 * right zone from its compose file rather than from whatever the column default
 * happened to be when the schema was written.
 *
 * `updated_at = created_at` is the whole condition, and it is what keeps this
 * from being an environment variable that overrules the product. The settings
 * row is written once by migration 0001 and touched again only when somebody
 * changes a setting, so the moment an admin picks a timezone this stops
 * applying and their choice stands.
 *
 * Returns what it did, so the startup log says so rather than changing the
 * meaning of every timestamp in the system silently.
 */
export async function applyConfiguredTimeZone(
  db: Database,
  timeZone: string,
): Promise<{ changed: boolean; timeZone: string }> {
  const [row] = await db
    .update(orgSettings)
    .set({ timezone: timeZone })
    .where(
      and(
        eq(orgSettings.id, 1),
        sql`${orgSettings.updatedAt} = ${orgSettings.createdAt}`,
        sql`${orgSettings.timezone} <> ${timeZone}`,
      ),
    )
    .returning({ timezone: orgSettings.timezone });

  if (row) invalidateOrgSettings();
  return { changed: row !== undefined, timeZone };
}
