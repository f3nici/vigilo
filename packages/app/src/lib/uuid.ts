/**
 * UUID v7 (CLAUDE.md: sync operations are idempotent by client-supplied UUID
 * v7).
 *
 * Version 7 rather than 4 because the first 48 bits are the timestamp, so ids
 * generated on a device sort in the order they were made. That is what lets
 * the outbox drain in creation order without a separate clock, and it makes a
 * page of records readable in a database client without joining anything.
 *
 * `crypto.randomUUID` only makes version 4, so this is built by hand from
 * `crypto.getRandomValues`.
 */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  // 48 bits of milliseconds since the epoch, big-endian.
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7 in the high nibble of byte 6, variant 10 in the top bits of 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
