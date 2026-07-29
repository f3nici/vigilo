<script setup lang="ts">
import { computed } from 'vue';
import type { TrendSeries } from '@vigilo/shared';
import { formatDateTimeIn } from '@/lib/format';

/**
 * A numeric field over time (doc 01 §8.2).
 *
 * Hand-drawn SVG rather than a charting library. The chart has one job, one
 * series and one rule that no library does by default: it must not draw a line
 * across a gap. Every general-purpose library interpolates, and a line drawn
 * through two days of nothing reads as two days of steady readings, which is a
 * claim the record does not support.
 *
 * Nothing here is coloured by value. Vigilo has no normal ranges, so a point
 * is never marked high or low (CLAUDE.md).
 */
const props = defineProps<{ series: TrendSeries }>();

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 48 };

const plot = computed(() => ({
  width: WIDTH - PAD.left - PAD.right,
  height: HEIGHT - PAD.top - PAD.bottom,
}));

const bounds = computed(() => {
  const values = props.series.points.map((point) => point.value);
  if (values.length === 0) return { min: 0, max: 1, from: 0, to: 1 };

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series still needs a band to sit in, or every point lands on one
  // pixel row and the chart looks broken rather than steady.
  const pad = max === min ? Math.max(1, Math.abs(max) * 0.1) : (max - min) * 0.1;

  const times = props.series.points.map((point) => Date.parse(point.at));
  return {
    min: min - pad,
    max: max + pad,
    from: Math.min(...times),
    to: Math.max(...times),
  };
});

function x(at: string): number {
  const { from, to } = bounds.value;
  const span = to - from || 1;
  return PAD.left + ((Date.parse(at) - from) / span) * plot.value.width;
}

function y(value: number): number {
  const { min, max } = bounds.value;
  const span = max - min || 1;
  return PAD.top + plot.value.height - ((value - min) / span) * plot.value.height;
}

/**
 * The line, broken wherever the series says there is a gap.
 *
 * One path per run of points, not one path with a jump: a single path with a
 * move-to in the middle is easy to get subtly wrong, and this way a gap is a
 * missing segment rather than a segment we hope nobody looks at.
 */
const segments = computed(() => {
  const gapStarts = new Set(props.series.gaps.map((gap) => gap.from));
  const runs: { at: string; value: number }[][] = [];
  let current: { at: string; value: number }[] = [];

  for (const point of props.series.points) {
    current.push(point);
    if (gapStarts.has(point.at)) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);

  return runs
    .filter((run) => run.length > 1)
    .map((run) => run.map((point) => `${x(point.at)},${y(point.value)}`).join(' '));
});

const gapBands = computed(() =>
  props.series.gaps.map((gap) => ({
    left: x(gap.from),
    width: Math.max(2, x(gap.to) - x(gap.from)),
    hours: gap.hours,
  })),
);

/** Four gridlines is enough to read a value off without becoming graph paper. */
const ticks = computed(() => {
  const { min, max } = bounds.value;
  return [0, 1, 2, 3].map((step) => {
    const value = min + ((max - min) / 3) * step;
    return { value: Math.round(value * 10) / 10, y: y(value) };
  });
});

const empty = computed(() => props.series.points.length === 0);
</script>

<template>
  <figure class="space-y-2">
    <figcaption class="text-text-secondary text-sm">
      {{ series.label }}<span v-if="series.unit"> ({{ series.unit }})</span>, {{ series.from }} to
      {{ series.to }}
    </figcaption>

    <p v-if="empty" class="card text-text-secondary p-6">
      Nothing was recorded for this field in that period.
    </p>

    <svg
      v-else
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      class="border-border-default bg-surface w-full rounded-lg border"
      role="img"
      :aria-label="`${series.label} from ${series.from} to ${series.to}. ${series.points.length} readings, lowest ${series.min}, highest ${series.max}. ${series.gaps.length} gaps with no readings.`"
    >
      <!--
        Gaps are drawn first and underneath, so the eye reads them as part of
        the chart rather than as something sitting on top of it.
      -->
      <g>
        <rect
          v-for="(gap, index) in gapBands"
          :key="index"
          :x="gap.left"
          :y="PAD.top"
          :width="gap.width"
          :height="plot.height"
          fill="var(--vigilo-border)"
          opacity="0.45"
        />
      </g>

      <g>
        <line
          v-for="tick in ticks"
          :key="tick.value"
          :x1="PAD.left"
          :x2="WIDTH - PAD.right"
          :y1="tick.y"
          :y2="tick.y"
          stroke="var(--vigilo-border)"
          stroke-width="1"
        />
        <text
          v-for="tick in ticks"
          :key="`label-${tick.value}`"
          :x="PAD.left - 8"
          :y="tick.y + 4"
          text-anchor="end"
          font-size="11"
          fill="var(--vigilo-text-secondary)"
        >
          {{ tick.value }}
        </text>
      </g>

      <polyline
        v-for="(points, index) in segments"
        :key="index"
        :points="points"
        fill="none"
        stroke="var(--vigilo-primary)"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />

      <circle
        v-for="point in series.points"
        :key="point.at"
        :cx="x(point.at)"
        :cy="y(point.value)"
        r="3"
        fill="var(--vigilo-primary)"
      />
    </svg>

    <p v-if="series.gaps.length > 0" class="text-text-secondary text-sm">
      The shaded bands are periods with no readings. Nothing is drawn across them, because nothing
      was recorded.
    </p>

    <!--
      The raw table underneath, as doc 01 §8.2 asks. A chart is a summary and
      somebody checking a specific reading needs the number.
    -->
    <details v-if="!empty" class="card p-4">
      <summary class="min-h-11 cursor-pointer">Readings ({{ series.points.length }})</summary>
      <table class="mt-3 w-full text-sm">
        <thead>
          <tr class="text-text-secondary text-left">
            <th class="pb-1 font-semibold">When</th>
            <th class="pb-1 font-semibold">Value</th>
            <th v-if="series.bucket !== 'none'" class="pb-1 font-semibold">Readings averaged</th>
          </tr>
        </thead>
        <tbody class="tabular">
          <tr v-for="point in series.points" :key="point.at">
            <td class="py-1">{{ formatDateTimeIn(point.at, series.timeZone) }}</td>
            <td class="py-1">{{ point.value }}{{ series.unit ? ` ${series.unit}` : '' }}</td>
            <td v-if="series.bucket !== 'none'" class="py-1">{{ point.samples }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </figure>
</template>
