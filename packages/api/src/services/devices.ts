import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { devices } from '../db/schema.js';

/**
 * Flags every device of a user for a local wipe, honoured at next contact
 * (doc 03 §2, doc 07 §7). The device cannot be reached directly, so this is a
 * marker the device reads rather than a push.
 */
export async function requestDeviceWipe(db: Database, userId: string): Promise<void> {
  await db
    .update(devices)
    .set({ wipeRequestedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(devices.userId, userId), isNull(devices.wipeRequestedAt)));
}
