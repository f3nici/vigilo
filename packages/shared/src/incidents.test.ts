import { describe, expect, it } from 'vitest';
import {
  actionIsOverdue,
  canCloseIncident,
  canRaiseIncident,
  canTransitionTo,
  closeIncidentRequestSchema,
  createIncidentRequestSchema,
  incidentSortRank,
  outstandingActions,
  type IncidentAction,
  type IncidentStatus,
} from './incidents.js';

const ID = '01952d3f-0000-7000-8000-000000000001';

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    occurredAt: '2026-03-02T08:00:00Z',
    discoveredAt: '2026-03-02T08:30:00Z',
    severity: 'moderate',
    summary: 'Fell in the bathroom',
    detail: 'Found on the floor beside the shower.',
    immediateAction: 'Helped up, checked for injury, called the nurse.',
    ...overrides,
  };
}

describe('raising an incident', () => {
  it('takes when it happened and when it was found separately', () => {
    // The gap between the two is often the most important thing on the record.
    const parsed = createIncidentRequestSchema.parse(incident());
    expect(parsed.occurredAt).not.toBe(parsed.discoveredAt);
  });

  it('refuses a discovery before the event', () => {
    const result = createIncidentRequestSchema.safeParse(
      incident({ discoveredAt: '2026-03-02T07:00:00Z' }),
    );
    expect(result.success).toBe(false);
  });

  it('allows discovery at the same moment, for something witnessed', () => {
    const result = createIncidentRequestSchema.safeParse(
      incident({ discoveredAt: '2026-03-02T08:00:00Z' }),
    );
    expect(result.success).toBe(true);
  });

  it('needs what happened and what was done about it', () => {
    expect(createIncidentRequestSchema.safeParse(incident({ detail: '' })).success).toBe(false);
    expect(createIncidentRequestSchema.safeParse(incident({ immediateAction: '' })).success).toBe(
      false,
    );
  });

  it('leaves injuries and who was involved optional', () => {
    const parsed = createIncidentRequestSchema.parse(incident());
    expect(parsed.injuries).toBeNull();
    expect(parsed.involved).toBeNull();
    expect(parsed.familyNotifiedAt).toBeNull();
  });
});

describe('who may do what', () => {
  it('lets any staff role raise one', () => {
    for (const role of ['worker', 'team_leader', 'nurse', 'admin'] as const) {
      expect(canRaiseIncident(role)).toBe(true);
    }
    expect(canRaiseIncident('participant')).toBe(false);
  });

  it('lets only a team leader, nurse or admin close one', () => {
    expect(canCloseIncident('worker')).toBe(false);
    expect(canCloseIncident('team_leader')).toBe(true);
    expect(canCloseIncident('nurse')).toBe(true);
    expect(canCloseIncident('admin')).toBe(true);
    expect(canCloseIncident('participant')).toBe(false);
  });
});

describe('the status workflow', () => {
  it('moves open to under review to closed', () => {
    expect(canTransitionTo('open', 'under_review')).toBe(true);
    expect(canTransitionTo('under_review', 'closed')).toBe(true);
  });

  it('allows closing straight from open', () => {
    // Not everything needs a review stage, and forcing one would teach people
    // to click through it.
    expect(canTransitionTo('open', 'closed')).toBe(true);
  });

  it('allows reopening', () => {
    // Something closed in March can turn out to matter in April, and a second
    // record about the same event is worse for anybody reading the history.
    expect(canTransitionTo('closed', 'under_review')).toBe(true);
    expect(canTransitionTo('closed', 'open')).toBe(true);
  });

  it('refuses a transition to the state it is already in', () => {
    for (const status of ['open', 'under_review', 'closed'] as IncidentStatus[]) {
      expect(canTransitionTo(status, status)).toBe(false);
    }
  });

  it('requires closure notes', () => {
    expect(closeIncidentRequestSchema.safeParse({ closureNotes: '   ' }).success).toBe(false);
    expect(
      closeIncidentRequestSchema.safeParse({ closureNotes: 'Reviewed with the team.' }).success,
    ).toBe(true);
  });
});

describe('follow-up actions', () => {
  function action(overrides: Partial<IncidentAction> = {}): IncidentAction {
    return {
      id: ID,
      incidentId: ID,
      action: 'Order a shower mat',
      assignedTo: null,
      assignedToName: null,
      dueAt: null,
      completedAt: null,
      completedBy: null,
      completedByName: null,
      note: null,
      createdAt: '2026-03-02T09:00:00Z',
      ...overrides,
    };
  }

  it('counts the ones nobody has finished', () => {
    expect(outstandingActions([action(), action({ completedAt: '2026-03-03T09:00:00Z' })])).toBe(1);
  });

  it('calls an action overdue only when it has a date and is not done', () => {
    const now = new Date('2026-03-10T00:00:00Z');
    expect(actionIsOverdue(action({ dueAt: '2026-03-05T00:00:00Z' }), now)).toBe(true);
    expect(actionIsOverdue(action({ dueAt: '2026-03-20T00:00:00Z' }), now)).toBe(false);
    expect(actionIsOverdue(action({ dueAt: null }), now)).toBe(false);
    expect(
      actionIsOverdue(
        action({ dueAt: '2026-03-05T00:00:00Z', completedAt: '2026-03-04T00:00:00Z' }),
        now,
      ),
    ).toBe(false);
  });
});

describe('ordering', () => {
  it('puts open above under review above closed', () => {
    const ordered = (['closed', 'open', 'under_review'] as IncidentStatus[])
      .map((status) => ({ status }))
      .sort((a, b) => incidentSortRank(a) - incidentSortRank(b))
      .map((one) => one.status);

    expect(ordered).toEqual(['open', 'under_review', 'closed']);
  });
});
