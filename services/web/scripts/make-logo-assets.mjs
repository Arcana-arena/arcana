/**
 * Derive the web logo assets from the artwork.
 *
 *   node services/web/scripts/make-logo-assets.mjs
 *
 * THE SOURCE FILE IS A FLATTENED EXPORT AND CANNOT BE USED AS-IS. It is
 * 1254x1254, 529 KB, has NO alpha channel, and its background is opaque
 * #000000 — so dropped straight into the header it is a black square sitting on
 * a #050b07 page, and half a megabyte for a 24-pixel mark. More than half the
 * canvas is padding: the mark itself occupies about 696x610 in the middle.
 *
 * WHAT THIS DOES, AND WHAT IT DOES NOT. It crops to the mark and recovers the
 * alpha the export flattened away. It does not redraw, recolour or restyle
 * anything — every pixel's colour comes back out as it went in.
 *
 * HOW THE ALPHA IS RECOVERED, because "make black transparent" is the wrong
 * answer and leaves dark fringes on every edge. The artwork is a bright mark
 * composited onto black, which is mathematically premultiplied alpha: an edge
 * pixel at half coverage is stored at half brightness. So alpha is read from the
 * brightest channel and the colour is UN-premultiplied by it. Keying out black
 * instead would keep those half-bright edge pixels fully opaque and ring the
 * whole mark in near-black.
 *
 * The outputs are committed. This script is here so that "where did this file
 * come from" has an answer that is not a memory.
 */
import sharp from 'sharp';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SRC = resolve(REPO, 'web example/Assets/arcana logo.png');
const OUT = resolve(HERE, '..', 'public');
const APP = resolve(HERE, '..', 'src', 'app');

/**
 * THE INPUT IS NOT IN THE REPOSITORY, ON PURPOSE, and this says so rather than
 * throwing ENOENT with a path in it.
 *
 * `web example/` is local to the design machine (see .gitignore). What this
 * script PRODUCES is committed — public/arcana-mark.png, public/brand/* and
 * the app icon — so a clone builds and serves the brand correctly; what it
 * cannot do is regenerate them. That is a deliberate trade, and the difference
 * between it and a broken checkout is exactly what this message carries.
 */
if (!existsSync(SRC)) {
  console.error(
    `The logo source is not here: ${SRC}\n\n` +
      'This is expected on any machine that is not the design machine. The assets this script\n' +
      'writes are committed, so nothing is missing from the site — only the ability to rebuild\n' +
      'them from the original. Copy "web example/Assets/arcana logo.png" into place to run it.',
  );
  process.exit(1);
}

const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

// The mark's own peak brightness, so full-coverage pixels come out fully
// opaque rather than at 239/255.
let peak = 0;
for (let i = 0; i < data.length; i += channels) {
  const m = Math.max(data[i], data[i + 1], data[i + 2]);
  if (m > peak) peak = m;
}

const rgba = Buffer.alloc(width * height * 4);
let minX = width, minY = height, maxX = -1, maxY = -1;

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    const o = (y * width + x) * 4;
    const m = Math.max(data[i], data[i + 1], data[i + 2]);
    const a = Math.min(255, Math.round((m / peak) * 255));
    if (a === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = rgba[o + 3] = 0;
      continue;
    }
    // Un-premultiply: the stored pixel is colour x coverage.
    const k = 255 / a;
    rgba[o] = Math.min(255, Math.round(data[i] * k));
    rgba[o + 1] = Math.min(255, Math.round(data[i + 1] * k));
    rgba[o + 2] = Math.min(255, Math.round(data[i + 2] * k));
    rgba[o + 3] = a;
    if (a > 8) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

// A SQUARE CROP, CENTRED ON THE MARK. A tight rectangular crop would make the
// logo a different shape from every box it is placed in, and it would be
// stretched by exactly the aspect difference in half of them.
const cx = (minX + maxX) / 2;
const cy = (minY + maxY) / 2;
const side = Math.max(maxX - minX, maxY - minY) + 24; // a little air
const left = Math.max(0, Math.round(cx - side / 2));
const top = Math.max(0, Math.round(cy - side / 2));
const size = Math.min(side, width - left, height - top);

const base = sharp(rgba, { raw: { width, height, channels: 4 } }).extract({
  left,
  top,
  width: size,
  height: size,
});

mkdirSync(OUT, { recursive: true });

// 128px covers the 24px header mark at any device pixel ratio anyone has.
await base.clone().resize(128, 128).png({ compressionLevel: 9 }).toFile(`${OUT}/arcana-mark.png`);
// Next serves app/icon.png as the favicon.
await base.clone().resize(64, 64).png({ compressionLevel: 9 }).toFile(`${APP}/icon.png`);

console.log(`source   ${width}x${height}, peak channel ${peak}`);
console.log(`mark     ${maxX - minX}x${maxY - minY} at ${minX},${minY}`);
console.log(`cropped  ${size}x${size} from ${left},${top}`);
console.log(`wrote    public/arcana-mark.png (128) and src/app/icon.png (64)`);
