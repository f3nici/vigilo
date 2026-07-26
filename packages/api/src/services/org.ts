import { eq } from 'drizzle-orm';
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
