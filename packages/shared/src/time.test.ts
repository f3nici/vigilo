import { describe, expect, it } from 'vitest';
import { clockSkewMs, isSkewSignificant } from './time.js';

describe('clockSkewMs', () => {
  it('is positive when the device is ahead of the server', () => {
    const server = new Date('2026-07-26T10:00:00.000Z');
    const device = new Date('2026-07-26T10:00:30.000Z');
    expect(clockSkewMs(device, server)).toBe(30_000);
  });

  it('is negative when the device is behind', () => {
    const server = new Date('2026-07-26T10:00:00.000Z');
    const device = new Date('2026-07-26T09:59:30.000Z');
    expect(clockSkewMs(device, server)).toBe(-30_000);
  });
});

describe('isSkewSignificant', () => {
  it('flags skew in either direction', () => {
    expect(isSkewSignificant(30_000)).toBe(false);
    expect(isSkewSignificant(5 * 60_000)).toBe(true);
    expect(isSkewSignificant(-5 * 60_000)).toBe(true);
  });
});
