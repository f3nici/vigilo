#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/**
 * Generates every icon and startup image from one SVG (doc 08 §5).
 *
 *   node scripts/generate-icons.mjs
 *
 * Run it when the mark changes; the output is committed so a build never needs
 * sharp. Doing it from one source is the point: an app icon that has drifted
 * from the in-app mark is the kind of thing nobody notices until it is on a
 * thousand home screens.
 *
 * Android and iOS want different things from the same drawing, and getting
 * either wrong looks like a broken app rather than a design choice:
 *
 * - Android maskable icons are cropped to whatever shape the launcher uses, so
 *   the mark sits inside the 80 percent safe zone. A full-bleed maskable icon
 *   comes out with its edges shaved off.
 * - Android 13 themed icons need a monochrome layer on transparency. Without
 *   one, a themed launcher renders our icon as a flat blob.
 * - iOS applies its own rounding and refuses transparency, so the Apple touch
 *   icon is square, opaque and unrounded.
 * - iOS shows a blank screen while an installed PWA starts unless startup
 *   images exist for that exact device size.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../public/icons');
const splashOut = path.resolve(here, '../public/splash');

/** Doc 08 §3. Deep teal ground, mark in the light surface colour. */
const TEAL = '#0F6E6E';
const LIGHT = '#F7F6F3';
/** The dark theme background, used for the startup images. See below. */
const DARK = '#141311';

const source = await readFile(path.join(here, 'icon.svg'), 'utf8');

/** The mark at a given size, in a given colour, on transparency. */
function markSvg(size, colour) {
  return Buffer.from(
    source
      .replace('width="32" height="32"', `width="${size}" height="${size}"`)
      .replaceAll('currentColor', colour),
  );
}

/**
 * A square icon: solid ground, mark centred at `coverage` of the width.
 *
 * `coverage` is the whole story for maskable icons. At 1.0 the mark reaches the
 * edges and a circular launcher mask cuts it; at 0.55 it sits comfortably
 * inside the safe zone whatever shape the launcher crops to.
 */
async function square(size, { ground, mark, coverage, transparent = false }) {
  const markSize = Math.round(size * coverage);
  const offset = Math.round((size - markSize) / 2);

  const base = transparent
    ? sharp({
        create: {
          width: size,
          height: size,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
    : sharp({ create: { width: size, height: size, channels: 4, background: ground } });

  return base
    .composite([
      { input: await sharp(markSvg(markSize, mark)).png().toBuffer(), top: offset, left: offset },
    ])
    .png()
    .toBuffer();
}

async function write(dir, name, buffer) {
  await writeFile(path.join(dir, name), buffer);
  console.log(`  ${path.relative(path.resolve(here, '..'), path.join(dir, name))}`);
}

await mkdir(out, { recursive: true });
await mkdir(splashOut, { recursive: true });

console.log('icons');

// Full-bleed, for anywhere the icon is shown as-is.
for (const size of [1024, 512, 192, 120, 48]) {
  await write(
    out,
    `icon-${size}.png`,
    await square(size, { ground: TEAL, mark: LIGHT, coverage: 0.62 }),
  );
}

// Android maskable. The launcher crops this, so the mark stays well inside.
for (const size of [512, 192]) {
  await write(
    out,
    `maskable-${size}.png`,
    await square(size, { ground: TEAL, mark: LIGHT, coverage: 0.44 }),
  );
}

// Android 13 themed icons: one layer, monochrome, on transparency. The system
// recolours it to the user's wallpaper palette.
await write(
  out,
  'monochrome-512.png',
  await square(512, { ground: TEAL, mark: '#FFFFFF', coverage: 0.44, transparent: true }),
);

// Capacitor's adaptive layers, ready for the Android phase. 432px is the layer
// size Android expects, of which the inner 264px is guaranteed visible.
await write(
  out,
  'adaptive-foreground-432.png',
  await square(432, { ground: TEAL, mark: LIGHT, coverage: 0.44, transparent: true }),
);
await write(
  out,
  'adaptive-background-432.png',
  await sharp({ create: { width: 432, height: 432, channels: 4, background: TEAL } })
    .png()
    .toBuffer(),
);

// iOS. Square, opaque, unrounded: iOS rounds it itself, and an icon that
// arrives pre-rounded gets rounded twice and looks wrong.
await write(
  out,
  'apple-touch-icon-180.png',
  await square(180, { ground: TEAL, mark: LIGHT, coverage: 0.6 }),
);

/**
 * iOS startup images.
 *
 * Deliberately dark, not light. Without these iOS shows a blank white screen
 * while the app starts, and this app is opened at 2am next to somebody who is
 * asleep. index.html already goes to some trouble to avoid a white flash
 * before first paint; a white launch screen would undo all of it. A dark
 * launch on a light-mode phone is a half second of dark, which is the smaller
 * problem by a long way.
 */
const devices = [
  [750, 1334], // SE, 8
  [828, 1792], // 11, XR
  [1125, 2436], // X, XS, 11 Pro
  [1242, 2688], // XS Max, 11 Pro Max
  [1170, 2532], // 12, 13, 14
  [1179, 2556], // 14 Pro, 15, 16
  [1206, 2622], // 16 Pro
  [1284, 2778], // 12/13 Pro Max, 14 Plus
  [1290, 2796], // 14/15/16 Pro Max
  [1320, 2868], // 16 Pro Max
  [1536, 2048], // iPad 9.7
  [1620, 2160], // iPad 10.2
  [1668, 2224], // iPad Pro 10.5
  [1668, 2388], // iPad Pro 11
  [2048, 2732], // iPad Pro 12.9
];

console.log('splash');

for (const [width, height] of devices) {
  for (const [orientation, w, h] of [
    ['portrait', width, height],
    ['landscape', height, width],
  ]) {
    const markSize = Math.round(Math.min(w, h) * 0.3);
    const buffer = await sharp({
      create: { width: w, height: h, channels: 4, background: DARK },
    })
      .composite([
        {
          input: await sharp(markSvg(markSize, TEAL)).png().toBuffer(),
          top: Math.round((h - markSize) / 2),
          left: Math.round((w - markSize) / 2),
        },
      ])
      // Two colours over a whole phone screen, so a palette costs nothing in
      // quality and turns 200 KB of true colour into a couple of KB. These are
      // committed and shipped, and a worker on mobile data pays for them.
      .png({ palette: true, compressionLevel: 9, effort: 10 })
      .toBuffer();

    await write(splashOut, `${orientation}-${w}x${h}.png`, buffer);
  }
}

console.log('done');
