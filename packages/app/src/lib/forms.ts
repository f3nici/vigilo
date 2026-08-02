import { ref, type Ref } from 'vue';

/**
 * Saying what is missing, rather than greying out the button.
 *
 * A disabled primary button is the worst answer to an incomplete form. It gives
 * no reason, it cannot be asked for one, and on a phone it reads as the app
 * being broken. Somebody hit "New check form" with no name typed and nothing at
 * all happened, which is what this exists to stop.
 *
 * So: the button always works. Pressing it either does the thing or says what
 * is needed and puts the cursor there. `busy` is still a fair reason to
 * disable, because the button genuinely does nothing useful while a request is
 * in flight and pressing it twice is worse than not being able to.
 */

/** What was missing, and which field it was missing from. */
export type FormProblem = { field: string; message: string };

/**
 * A check to run before submitting. Returns the problem or null.
 *
 * Written as a list so a form states its requirements in one place, in the
 * order the fields appear, and reports the first one rather than a wall.
 */
export type FormCheck = () => FormProblem | null;

export type FormGuard = {
  /** The current complaint, cleared as soon as a submit gets through. */
  problem: Ref<FormProblem | null>;
  /** True when this field is the one being complained about. */
  invalid: (field: string) => boolean;
  /**
   * Runs the checks. True when the form is good to submit, false when it is
   * not, in which case the problem is set and the field has been focused.
   */
  ready: (...checks: FormCheck[]) => boolean;
  clear: () => void;
};

export function useFormGuard(): FormGuard {
  const problem = ref<FormProblem | null>(null);

  const clear = () => {
    problem.value = null;
  };

  return {
    problem,
    invalid: (field) => problem.value?.field === field,
    clear,
    ready: (...checks) => {
      for (const check of checks) {
        const found = check();
        if (found === null) continue;
        problem.value = found;
        /*
         * Focus rather than scroll. It moves the screen reader to the field as
         * well as the eye, and the browser scrolls to it as a side effect.
         * Deferred a tick so it survives the re-render that shows the message.
         */
        queueMicrotask(() => document.getElementById(found.field)?.focus());
        return false;
      }
      clear();
      return true;
    },
  };
}

/** The commonest check by a distance: a field somebody has to type in. */
export function needsText(field: string, value: string, message: string): FormCheck {
  return () => (value.trim() === '' ? { field, message } : null);
}

/** A picker with nothing chosen. */
export function needsChoice(field: string, value: string, message: string): FormCheck {
  return () => (value === '' ? { field, message } : null);
}

/** Anything a form works out for itself. */
export function needs(field: string, ok: boolean, message: string): FormCheck {
  return () => (ok ? null : { field, message });
}
