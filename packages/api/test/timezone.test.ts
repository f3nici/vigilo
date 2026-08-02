import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  applyConfiguredTimeZone,
  getOrgSettings,
  invalidateOrgSettings,
} from '../src/services/org.js';
import { createHarness, resetData, TEST_TIME_ZONE, type Harness } from './helpers.js';

/**
 * The organisation timezone (D84).
 *
 * Every window, every dose and every "daily" boundary is decided in it, and it
 * is the only zone staff ever see. It got here because the schema default was
 * Melbourne, this team is in Perth, and a 14:00 to 16:00 window labelled two
 * hours away from the hours anybody works made the countdown look like it was
 * pointing at the start of the window rather than the end.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetData(h.ownerDb);
});

/** Puts the row back to the state a fresh install is in. */
async function neverEdited(timeZone: string): Promise<void> {
  await h.ownerDb.execute(
    sql`update org_settings set timezone = ${timeZone}, updated_at = created_at where id = 1`,
  );
  invalidateOrgSettings();
}

describe('the configured timezone', () => {
  it('applies to a settings row nobody has edited', async () => {
    await neverEdited('Australia/Melbourne');

    const result = await applyConfiguredTimeZone(h.ownerDb, 'Australia/Perth');

    expect(result.changed).toBe(true);
    expect((await getOrgSettings(h.ownerDb)).timezone).toBe('Australia/Perth');
  });

  it('leaves a timezone somebody chose deliberately alone', async () => {
    /*
     * The whole reason this is not simply authoritative on every startup. An
     * environment variable that quietly overrules the product turns the
     * settings screen into a lie, and the setting it overrules decides what
     * day every record belongs to.
     */
    await h.ownerDb.execute(
      sql`update org_settings set timezone = 'Pacific/Auckland', updated_at = now() where id = 1`,
    );
    invalidateOrgSettings();

    const result = await applyConfiguredTimeZone(h.ownerDb, 'Australia/Perth');

    expect(result.changed).toBe(false);
    expect((await getOrgSettings(h.ownerDb)).timezone).toBe('Pacific/Auckland');
  });

  it('reports no change when it already matches', async () => {
    await neverEdited('Australia/Perth');
    expect((await applyConfiguredTimeZone(h.ownerDb, 'Australia/Perth')).changed).toBe(false);
  });

  it('is safe to run on every startup', async () => {
    await neverEdited('Australia/Melbourne');

    await applyConfiguredTimeZone(h.ownerDb, 'Australia/Perth');
    const second = await applyConfiguredTimeZone(h.ownerDb, 'Australia/Perth');

    // Still never edited by a person, so a later change to the variable would
    // still apply. What it must not do is report a change it did not make.
    expect(second.changed).toBe(false);
    expect((await getOrgSettings(h.ownerDb)).timezone).toBe('Australia/Perth');
  });

  it('empties the cache, so the next read is not the old zone', async () => {
    await neverEdited('Australia/Melbourne');
    // Warm the 30-second cache with the old value first.
    expect((await getOrgSettings(h.ownerDb)).timezone).toBe('Australia/Melbourne');

    await applyConfiguredTimeZone(h.ownerDb, 'Australia/Perth');

    expect((await getOrgSettings(h.ownerDb)).timezone).toBe('Australia/Perth');
  });

  it('is Perth out of the box', async () => {
    // The column default, which is what a fresh database gets before the
    // variable is read at all.
    const [row] = await h.ownerDb.execute(
      sql`select column_default from information_schema.columns
          where table_name = 'org_settings' and column_name = 'timezone'`,
    );
    expect(String(row!.column_default)).toContain('Australia/Perth');
  });

  it('leaves the suite on the zone its assertions are written against', async () => {
    // `resetData` sets it explicitly. Without that, the day the default moved
    // every clock-hour assertion in this repository quietly changed meaning.
    expect((await getOrgSettings(h.ownerDb)).timezone).toBe(TEST_TIME_ZONE);
  });
});
