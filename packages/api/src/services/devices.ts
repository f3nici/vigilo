import { and, eq, isNull } from 'drizzle-orm';
import type { Device, RegisterDeviceRequest } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { devices } from '../db/schema.js';
import { HttpError } from '../middleware/errors.js';

function toDevice(row: typeof devices.$inferSelect): Device {
  return {
    id: row.id,
    platform: row.platform,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSyncRevision: row.lastSyncRevision,
    wipeRequested: row.wipeRequestedAt !== null,
  };
}

/**
 * A device announcing itself, on every sign-in and every app start.
 *
 * The id comes from the device and is stable, so this is an upsert. Claiming a
 * device row for a different user is deliberately allowed: a shared work phone
 * passed between two workers on a handover is a real thing, and the row is
 * about the hardware, not about the person.
 *
 * Registering clears any outstanding wipe request. By the time a device is
 * talking to us again under an active account, the wipe has either happened or
 * the reason for it is gone.
 */
export async function registerDevice(
  db: Database,
  userId: string,
  request: RegisterDeviceRequest,
): Promise<Device> {
  const now = new Date();
  const [row] = await db
    .insert(devices)
    .values({
      id: request.deviceId,
      userId,
      platform: request.platform,
      model: request.model,
      osVersion: request.osVersion,
      appVersion: request.appVersion,
    })
    .onConflictDoUpdate({
      target: devices.id,
      set: {
        userId,
        platform: request.platform,
        model: request.model,
        osVersion: request.osVersion,
        appVersion: request.appVersion,
        updatedAt: now,
        wipeRequestedAt: null,
      },
    })
    .returning();

  return toDevice(row!);
}

export async function getDevice(db: Database, deviceId: string, userId: string): Promise<Device> {
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .limit(1);
  if (!row) throw new HttpError('not_found', 'That device is not registered.');
  return toDevice(row);
}

/**
 * Records how far a device has synced.
 *
 * Written after the device acknowledges a page, not when the page is sent, so
 * the number here is what the device actually holds rather than what it was
 * offered. It drives the "devices not synced recently" panel on the admin
 * dashboard (doc 06 §5).
 */
export async function recordSyncCursor(
  db: Database,
  deviceId: string | null,
  userId: string,
  revision: number,
): Promise<void> {
  if (deviceId === null) return;
  await db
    .update(devices)
    .set({ lastSyncAt: new Date(), lastSyncRevision: revision, updatedAt: new Date() })
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)));
}

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
