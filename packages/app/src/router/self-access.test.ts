import { describe, expect, it } from 'vitest';
import { homeFor, router, SELF_ACCESS_ROUTES } from './index.js';

/**
 * The routing half of participant self-access (doc 06 §6).
 *
 * The server is the authority and refuses everything else for this role
 * anyway. These are about what a person is shown: a participant following an
 * old bookmark should land on their own day, not on a staff screen full of
 * failed requests.
 */
describe('where a participant lands', () => {
  it('sends them to their own day, not to the worker home screen', () => {
    expect(homeFor('participant')).toBe('my-day');
  });

  it('leaves every staff role on Today', () => {
    for (const role of ['admin', 'team_leader', 'nurse', 'worker', undefined]) {
      expect(homeFor(role)).toBe('today');
    }
  });
});

describe('the self-access route list', () => {
  /** Every route the app declares, flattened past the shell's children. */
  const declared = router
    .getRoutes()
    .map((route) => String(route.name))
    .filter((name) => name !== 'undefined');

  it('holds the three screens doc 06 §6 describes', () => {
    expect(SELF_ACCESS_ROUTES.has('my-day')).toBe(true);
    expect(SELF_ACCESS_ROUTES.has('my-records')).toBe(true);
    expect(SELF_ACCESS_ROUTES.has('my-reports')).toBe(true);
  });

  it('holds no staff screen', () => {
    // The failure this catches is a staff route being added to the allow-list
    // to make a redirect loop go away.
    for (const name of ['today', 'participants', 'participant', 'reports', 'users', 'system']) {
      expect(SELF_ACCESS_ROUTES.has(name)).toBe(false);
    }
  });

  it('names only routes that exist', () => {
    // A typo here would silently send a participant to their day forever,
    // including from the screen that was meant to be reachable.
    for (const name of SELF_ACCESS_ROUTES) {
      expect(declared, `${name} is not a declared route`).toContain(name);
    }
  });

  it('still lets them resolve a forced password change', () => {
    // Otherwise the guard would bounce them off the one screen that clears the
    // requirement stopping them reaching anything else.
    expect(SELF_ACCESS_ROUTES.has('set-password')).toBe(true);
    expect(SELF_ACCESS_ROUTES.has('set-up-two-factor')).toBe(true);
  });
});

describe('the participant screens', () => {
  it('are declared for that role alone', () => {
    for (const name of ['my-day', 'my-records', 'my-reports']) {
      const route = router.getRoutes().find((one) => one.name === name);
      expect(route?.meta.roles).toEqual(['participant']);
    }
  });
});
