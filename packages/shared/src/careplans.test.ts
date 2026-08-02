import { describe, expect, it } from 'vitest';
import { createCarePlanRequestSchema, publishCarePlanVersionRequestSchema } from './careplans.js';

describe('the plan', () => {
  it('starts with an empty body when none is given', () => {
    expect(createCarePlanRequestSchema.parse({ title: 'Daily support' }).body).toBe('');
  });

  it('requires a change summary to publish', () => {
    // Every assigned worker is about to be asked to read this again, so "what
    // changed" is the difference between skimming and finding the paragraph.
    expect(publishCarePlanVersionRequestSchema.safeParse({ changeSummary: '' }).success).toBe(
      false,
    );
    expect(publishCarePlanVersionRequestSchema.safeParse({ changeSummary: '  ' }).success).toBe(
      false,
    );
    expect(
      publishCarePlanVersionRequestSchema.safeParse({ changeSummary: 'Added the seizure plan' })
        .success,
    ).toBe(true);
  });
});
