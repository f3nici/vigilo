import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuid';

describe('uuid v7', () => {
  it('looks like a uuid', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sorts in the order the ids were made', () => {
    // This is the reason for version 7 over version 4. The outbox drains in id
    // order, so a create has to sort before the update to it without needing a
    // separate clock (CLAUDE.md).
    const early = uuidv7(new Date('2026-07-28T09:00:00.000Z').getTime());
    const later = uuidv7(new Date('2026-07-28T09:00:01.000Z').getTime());
    expect(early < later).toBe(true);
  });

  it('carries the timestamp it was given', () => {
    const at = new Date('2026-07-28T09:00:00.000Z').getTime();
    const hex = uuidv7(at).replace(/-/g, '').slice(0, 12);
    expect(Number.parseInt(hex, 16)).toBe(at);
  });

  it('does not repeat within a millisecond', () => {
    const at = Date.now();
    const ids = new Set(Array.from({ length: 500 }, () => uuidv7(at)));
    expect(ids.size).toBe(500);
  });
});
