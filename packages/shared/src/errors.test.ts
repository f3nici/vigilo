import { describe, expect, it } from 'vitest';
import { apiError, apiErrorSchema, errorCodes, errorStatus } from './errors.js';

describe('apiError', () => {
  it('builds the envelope from doc 04 §1', () => {
    const err = apiError('scope_denied', 'You are not assigned to this participant.');
    expect(apiErrorSchema.parse(err)).toEqual({
      error: {
        code: 'scope_denied',
        message: 'You are not assigned to this participant.',
        details: {},
      },
    });
  });
});

describe('errorStatus', () => {
  it('maps every error code to a status', () => {
    for (const code of errorCodes) {
      expect(errorStatus[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
