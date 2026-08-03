import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CheckValue, TemplateSchema } from '@vigilo/shared';
import DynamicForm from './DynamicForm.vue';

/**
 * The number box, which has to hold a decimal a worker is partway through
 * typing.
 *
 * Rendering `String(value.number)` straight back into the input took the point
 * away as fast as it was typed, so a field configured for one decimal place
 * could not record one.
 */

function schemaWith(decimals: number): TemplateSchema {
  return {
    fields: [
      {
        key: 'temp',
        type: 'number',
        label: 'Temperature',
        required: true,
        sort: 0,
        unit: 'C',
        decimals,
      },
    ],
  };
}

/** Mounts the form the way a screen holds it: values in, changes back out. */
function mountForm(decimals: number) {
  const values: Record<string, CheckValue> = {};
  const wrapper = mount(DynamicForm, {
    props: {
      schema: schemaWith(decimals),
      values,
      onChange: async (value: CheckValue) => {
        await wrapper.setProps({ values: { ...wrapper.props().values, [value.fieldKey]: value } });
      },
    },
  });
  return wrapper;
}

async function type(wrapper: ReturnType<typeof mountForm>, text: string): Promise<void> {
  const input = wrapper.get('input');
  (input.element as HTMLInputElement).value = text;
  await input.trigger('input');
}

describe('the number field', () => {
  it('keeps the decimal point while it is being typed', async () => {
    const wrapper = mountForm(1);

    await type(wrapper, '36');
    await type(wrapper, '36.');

    expect(wrapper.get('input').element.value).toBe('36.');

    await type(wrapper, '36.4');
    expect(wrapper.get('input').element.value).toBe('36.4');
    expect(wrapper.props().values.temp?.number).toBe(36.4);
  });

  it('keeps a trailing zero, which parses to the same number', async () => {
    const wrapper = mountForm(2);

    await type(wrapper, '36.40');

    expect(wrapper.get('input').element.value).toBe('36.40');
    expect(wrapper.props().values.temp?.number).toBe(36.4);
  });

  it('records nothing for a point on its own', async () => {
    const wrapper = mountForm(1);

    await type(wrapper, '.');

    expect(wrapper.get('input').element.value).toBe('.');
    expect(wrapper.props().values.temp?.number).toBeNull();
  });

  it('refuses anything that is not on its way to a number', async () => {
    const wrapper = mountForm(1);

    await type(wrapper, '36');
    await type(wrapper, '36a');

    expect(wrapper.get('input').element.value).toBe('36');
    expect(wrapper.props().values.temp?.number).toBe(36);
  });

  it('clears back to empty', async () => {
    const wrapper = mountForm(1);

    await type(wrapper, '36.4');
    await type(wrapper, '');

    expect(wrapper.get('input').element.value).toBe('');
    expect(wrapper.props().values.temp?.number).toBeNull();
  });

  /**
   * A whole-number field still takes the point rather than blocking it, and
   * says so. A primary button is never greyed out for missing input (D78) and
   * a keystroke silently swallowed is the same failure one level down.
   */
  it('lets a whole-number field be told it takes a whole number', async () => {
    const wrapper = mountForm(0);

    await type(wrapper, '36.4');

    expect(wrapper.get('input').element.value).toBe('36.4');
    expect(wrapper.text()).toContain('Temperature takes a whole number.');
  });
});
