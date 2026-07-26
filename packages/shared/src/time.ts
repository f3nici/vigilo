/**
 * Time helpers.
 *
 * The server clock is authoritative for anything affecting lateness or
 * ordering (doc 04 §1). Devices measure their own skew against the
 * `X-Server-Time` header rather than trusting themselves.
 */

/** ISO 8601 with offset, which is the only time format on the wire. */
export function toIso(date: Date): string {
  return date.toISOString();
}

/**
 * Device clock skew in milliseconds: positive means the device is ahead of
 * the server.
 */
export function clockSkewMs(deviceNow: Date, serverTime: Date): number {
  return deviceNow.getTime() - serverTime.getTime();
}

/** Skew past this is worth showing the user, since it distorts recorded_at. */
export const SKEW_WARNING_MS = 2 * 60 * 1000;

export function isSkewSignificant(skewMs: number): boolean {
  return Math.abs(skewMs) > SKEW_WARNING_MS;
}
