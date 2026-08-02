import { describe, expect, it, vi } from 'vitest';
import { needs, needsChoice, needsText, useFormGuard } from './forms';

describe('the form guard', () => {
  it('lets a complete form through and says nothing', () => {
    const guard = useFormGuard();
    expect(guard.ready(needsText('name', 'Vent observations', 'Give it a name.'))).toBe(true);
    expect(guard.problem.value).toBeNull();
  });

  it('reports the first thing missing, in the order the fields appear', () => {
    // One complaint, not a wall. A form that lists everything wrong at once
    // reads as an accusation on a phone.
    const guard = useFormGuard();
    expect(
      guard.ready(
        needsChoice('category', '', 'Choose what this entry is about.'),
        needsText('body', '', 'Write what happened.'),
      ),
    ).toBe(false);
    expect(guard.problem.value).toEqual({
      field: 'category',
      message: 'Choose what this entry is about.',
    });
  });

  it('treats whitespace as empty, because a space is not an answer', () => {
    const guard = useFormGuard();
    expect(guard.ready(needsText('name', '   \n ', 'Give it a name.'))).toBe(false);
  });

  it('knows which field to point at, and only that one', () => {
    const guard = useFormGuard();
    guard.ready(needsText('name', '', 'Give it a name.'));
    expect(guard.invalid('name')).toBe(true);
    expect(guard.invalid('description')).toBe(false);
  });

  it('clears once the form gets through, so an old message cannot linger', () => {
    const guard = useFormGuard();
    guard.ready(needsText('name', '', 'Give it a name.'));
    expect(guard.problem.value).not.toBeNull();
    expect(guard.ready(needsText('name', 'Now named', 'Give it a name.'))).toBe(true);
    expect(guard.problem.value).toBeNull();
    expect(guard.invalid('name')).toBe(false);
  });

  it('clears when the field is typed into', () => {
    const guard = useFormGuard();
    guard.ready(needsText('name', '', 'Give it a name.'));
    guard.clear();
    expect(guard.problem.value).toBeNull();
  });

  it('moves focus to the field it named', async () => {
    // The message alone is no use to somebody who cannot see the top of a long
    // form, or who is using a screen reader.
    const guard = useFormGuard();
    const input = document.createElement('input');
    input.id = 'name';
    document.body.append(input);
    const focus = vi.spyOn(input, 'focus');

    guard.ready(needsText('name', '', 'Give it a name.'));
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));

    expect(focus).toHaveBeenCalled();
    input.remove();
  });

  it('carries a message a form worked out for itself', () => {
    const guard = useFormGuard();
    guard.ready(needs('reading', false, 'Urine output cannot be above 5000 ml.'));
    expect(guard.problem.value?.message).toBe('Urine output cannot be above 5000 ml.');
  });
});
