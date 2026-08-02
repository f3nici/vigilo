<script setup lang="ts">
import { ref } from 'vue';
import { fieldTypes, type FieldType } from '@vigilo/shared';

/**
 * What each field type is for, in the words of the person building the form.
 *
 * An admin picking between "Checklist", "One of" and "Several of" is being
 * asked a question they have no way to answer from the names alone. Rather
 * than a paragraph of help text nobody reads, it sits behind one icon next to
 * the picker, which is where the question gets asked.
 *
 * The list is keyed by `FieldType`, so a field type added later will not
 * compile until somebody has written down what it is for.
 */
const open = ref(false);

type Explanation = { name: string; what: string; example: string };

const guide: Record<FieldType, Explanation> = {
  number: {
    name: 'Number',
    what: 'A measurement or a count. Give it a unit if it has one, or leave the unit blank for a plain count.',
    example: 'Temperature in °C, or how many times someone was repositioned.',
  },
  boolean: {
    name: 'Yes or no',
    what: 'Two buttons. Use it when the answer really is only one of the two.',
    example: 'Did they eat breakfast?',
  },
  checklist: {
    name: 'Checklist',
    what: 'A list of things to tick off as they are done. Any number can be ticked, and unticked ones are left as not done.',
    example: 'Repositioned, mouth care given, water offered.',
  },
  single_choice: {
    name: 'One of',
    what: 'A list where exactly one answer is right. Picking a second replaces the first.',
    example: 'Settled, unsettled, asleep.',
  },
  multi_choice: {
    name: 'Several of',
    what: 'A list where more than one answer can be true at once.',
    example: 'Which supports were used this shift.',
  },
  text: {
    name: 'Text',
    what: 'Words a worker types. A single line by default, which is what most of these want. Switch it to several lines only when you are asking for a paragraph.',
    example: 'A single line for "where were they", several lines for "how was the afternoon".',
  },
  date: {
    name: 'Date',
    what: 'A day, with no time on it.',
    example: 'The date a dressing was changed.',
  },
  time: {
    name: 'Time',
    what: 'A time of day. Turn on several times when the same thing can happen more than once in one check.',
    example: 'When a nebuliser was given, which might be twice in two hours.',
  },
  datetime: {
    name: 'Date and time',
    what: 'A day and a time together. Only needed when it might not be today.',
    example: 'When something happened that is being written up the next morning.',
  },
  info: {
    name: 'Information',
    what: 'Guidance for the worker filling the form in. It records nothing and is never part of the answer. Takes headings, lists, bold and tables.',
    example:
      'A chart of what each type of secretion looks like, next to the field asking about it.',
  },
};
</script>

<template>
  <span>
    <button
      type="button"
      class="min-h-11 px-2 text-lg"
      :aria-expanded="open"
      title="What are these field types?"
      aria-label="What are these field types?"
      @click="open = true"
    >
      &#128161;
    </button>

    <!--
      A plain overlay rather than a native dialog: this has to work the same on
      an admin's laptop and on a phone, and `showModal` is one of the places
      where those two still differ.
    -->
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      @click.self="open = false"
    >
      <div
        class="card my-8 w-full max-w-2xl p-5"
        role="dialog"
        aria-modal="true"
        aria-label="Field types"
      >
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold">What each field type is for</h2>
          <button
            type="button"
            class="btn border-border-default ml-auto border"
            @click="open = false"
          >
            Close
          </button>
        </div>

        <dl class="mt-4 space-y-4">
          <div v-for="type in fieldTypes" :key="type">
            <dt class="font-semibold">{{ guide[type].name }}</dt>
            <dd class="text-text-secondary">
              {{ guide[type].what }}
              <span class="mt-1 block italic">For example: {{ guide[type].example }}</span>
            </dd>
          </div>
        </dl>

        <p class="text-text-secondary mt-4 text-sm">
          Nothing on a check form judges a value. There is no way to mark a reading as normal, high
          or low, and there never will be. Vigilo records what was seen.
        </p>
      </div>
    </div>
  </span>
</template>
