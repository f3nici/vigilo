import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CheckWindow, MissedReasonCode, PutMissReasonRequest } from '@vigilo/shared';

/**
 * Answering a run of missed checks with one reason (#19).
 *
 * The rule under test is that "bulk" is only a shortcut through the screen: one
 * write per window still goes out, each with its own id, so a bulk answer and
 * forty answers by hand leave the record in the same state. The second rule is
 * that a note the chosen code requires is enforced here too, because a reason
 * that means nothing is worse in forty places than in one.
 */

const recorded: { windowId: string; participantId: string; request: PutMissReasonRequest }[] = [];
let failOn: string | null = null;

vi.mock('@/lib/records', () => ({
  recordMissReasonFor: (input: {
    windowId: string;
    participantId: string;
    request: PutMissReasonRequest;
  }) => {
    if (input.windowId === failOn) return Promise.reject(new Error('nope'));
    recorded.push(input);
    return Promise.resolve({ queued: true });
  },
}));

vi.mock('@/api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
}));

const { default: BulkMissReason } = await import('./BulkMissReason.vue');

function window(id: string, overrides: Partial<CheckWindow> = {}): CheckWindow {
  return {
    id,
    participantId: 'p1',
    scheduleId: 's1',
    scheduleName: 'Two hourly',
    segmentId: 'seg1',
    templateVersionId: 'v1',
    templateName: 'Two hourly',
    startsAt: '2026-07-27T11:00:00Z',
    endsAt: '2026-07-27T13:00:00Z',
    expected: true,
    coverageReason: null,
    status: 'missed',
    completedAt: null,
    isLate: false,
    lateByMinutes: null,
    requiredFieldCount: 1,
    filledRequiredCount: 0,
    entryId: null,
    recordedByName: null,
    missReason: null,
    ...overrides,
  };
}

const codes: MissedReasonCode[] = [
  {
    id: 'c1',
    code: 'not_home',
    label: 'Not at home',
    requiresNote: false,
    sortOrder: 0,
    active: true,
  },
  { id: 'c2', code: 'other', label: 'Other', requiresNote: true, sortOrder: 1, active: true },
];

function mountPanel(windows: CheckWindow[]) {
  return mount(BulkMissReason, {
    props: { windows, reasonCodes: codes, timeZone: 'Australia/Perth' },
    global: { stubs: { RouterLink: true } },
  });
}

async function choose(wrapper: ReturnType<typeof mountPanel>, codeId: string): Promise<void> {
  await wrapper.get('#bulk-reason').setValue(codeId);
}

beforeEach(() => {
  recorded.length = 0;
  failOn = null;
});

describe('answering several missed checks at once', () => {
  it('writes one reason per ticked window', async () => {
    const wrapper = mountPanel([window('w1'), window('w2'), window('w3')]);

    await choose(wrapper, 'c1');
    await wrapper.get('button.btn-primary').trigger('click');
    await new Promise((resolve) => setTimeout(resolve));

    expect(recorded.map((one) => one.windowId)).toEqual(['w1', 'w2', 'w3']);
    expect(recorded.every((one) => one.request.reasonCodeId === 'c1')).toBe(true);
    expect(wrapper.emitted('done')).toHaveLength(1);
  });

  it('leaves out a window somebody unticked', async () => {
    const wrapper = mountPanel([window('w1'), window('w2')]);

    await wrapper.findAll('input[type="checkbox"]')[1]!.setValue(false);
    await choose(wrapper, 'c1');
    await wrapper.get('button.btn-primary').trigger('click');
    await new Promise((resolve) => setTimeout(resolve));

    expect(recorded.map((one) => one.windowId)).toEqual(['w1']);
  });

  it('refuses a code that needs a note until there is one', async () => {
    const wrapper = mountPanel([window('w1'), window('w2')]);

    await choose(wrapper, 'c2');
    await wrapper.get('button.btn-primary').trigger('click');
    await new Promise((resolve) => setTimeout(resolve));

    expect(recorded).toHaveLength(0);
    expect(wrapper.emitted('done')).toBeUndefined();

    await wrapper.get('#bulk-note').setValue('Family took her out for the day.');
    await wrapper.get('button.btn-primary').trigger('click');
    await new Promise((resolve) => setTimeout(resolve));

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.request.note).toBe('Family took her out for the day.');
  });

  it('says so when one fails and still answers the rest', async () => {
    failOn = 'w2';
    const wrapper = mountPanel([window('w1'), window('w2'), window('w3')]);

    await choose(wrapper, 'c1');
    await wrapper.get('button.btn-primary').trigger('click');
    await new Promise((resolve) => setTimeout(resolve));

    expect(recorded.map((one) => one.windowId)).toEqual(['w1', 'w3']);
    expect(wrapper.emitted('done')).toBeUndefined();
    expect(wrapper.text()).toContain('1 of 3 could not be answered');
  });

  it('asks for a window before it asks for a reason', async () => {
    const wrapper = mountPanel([window('w1'), window('w2')]);

    await wrapper.get('button.btn-primary').trigger('click');
    await new Promise((resolve) => setTimeout(resolve));
    expect(wrapper.text()).toContain('Choose why these checks were missed');

    await wrapper.findAll('input[type="checkbox"]').forEach((box) => void box.setValue(false));
    await wrapper.get('button.btn-primary').trigger('click');
    await new Promise((resolve) => setTimeout(resolve));

    expect(recorded).toHaveLength(0);
    expect(wrapper.text()).toContain('Tick at least one check');
  });
});
