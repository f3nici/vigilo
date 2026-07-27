<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import QRCode from 'qrcode';

/**
 * Rendered locally into a canvas. The library is bundled, not fetched: nothing
 * about an enrolment secret should leave the device, and a CDN would put it in
 * a URL on someone else's server.
 */
const props = withDefaults(defineProps<{ value: string; size?: number }>(), { size: 200 });

const canvas = ref<HTMLCanvasElement | null>(null);
const failed = ref(false);

async function draw(): Promise<void> {
  if (!canvas.value) return;
  try {
    await QRCode.toCanvas(canvas.value, props.value, {
      width: props.size,
      margin: 1,
      // Fixed black on white: a QR code has to survive being scanned from a
      // dim screen, and theming it costs contrast for nothing.
      color: { dark: '#000000', light: '#ffffff' },
    });
    failed.value = false;
  } catch {
    failed.value = true;
  }
}

onMounted(draw);
watch(() => [props.value, props.size], draw);
</script>

<template>
  <div>
    <canvas
      v-show="!failed"
      ref="canvas"
      :width="size"
      :height="size"
      class="rounded"
      role="img"
      aria-label="Two-factor setup QR code"
    ></canvas>
    <p v-if="failed" class="text-text-secondary text-sm">
      Could not draw the QR code. Enter the key by hand instead.
    </p>
  </div>
</template>
