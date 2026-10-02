#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, die } from './_args.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const USAGE = `usage: node ico.mjs <image> --out <file.ico> [--sizes 16,32,48] [--png]
       node ico.mjs <16.png> <32.png> <48.png> --out <file.ico> [--png]
       node ico.mjs <file.ico> --info

  <image>         square PNG, SVG, WebP… resized to every --sizes entry
  several images  each one goes in at its own size, no resize — for
                  small sizes retouched by hand
  --sizes <list>  default 16,32,48
  --png           PNG entries instead of BMP 32bpp; 256 is always PNG
  --out <file>    output .ico
  --info          list the entries of existing .ico files`;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function info(file) {
  const b = readFileSync(file);
  const type = b.length >= 6 && b.readUInt16LE(0) === 0 ? b.readUInt16LE(2) : 0;
  if (type !== 1 && type !== 2) die(`${file}: not an ICO`);
  const count = b.readUInt16LE(4);
  console.log(`${file}: ${type === 1 ? 'icon' : 'cursor'}, ${count} image(s), ${b.length} bytes`);
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = `${b[e] || 256}x${b[e + 1] || 256}`;
    const bytes = b.readUInt32LE(e + 8);
    const offset = b.readUInt32LE(e + 12);
    if (offset + bytes > b.length) {
      console.log(`  ${size}  data out of file bounds`);
      continue;
    }
    const data = b.subarray(offset, offset + bytes);
    let actual;
    if (data.subarray(0, 8).equals(PNG_SIG)) {
      const bpp = data[24] * PNG_CHANNELS[data[25]];
      actual = `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}  PNG ${bpp}bpp`;
    } else {
      // BMP height covers the color bitmap and the AND mask together
      actual = `${data.readInt32LE(4)}x${data.readInt32LE(8) / 2}  BMP ${data.readUInt16LE(14)}bpp`;
    }
    console.log(`  ${size.padEnd(8)} ${actual}  ${bytes} bytes`);
  }
}

async function open(file) {
  // SVG needs no density: resize renders it straight at the target size
  const image = sharp(file);
  const { width, height } = await image.metadata();
  if (width !== height) die(`${file}: ${width}x${height}, must be square`);
  return { image, width };
}

function bmp(rgba, size) {
  const maskRow = Math.ceil(size / 32) * 4;
  const color = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // BMP rows go bottom-up
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = (row * size + x) * 4;
      color[d] = rgba[s + 2];
      color[d + 1] = rgba[s + 1];
      color[d + 2] = rgba[s];
      color[d + 3] = rgba[s + 3];
      // renderers that ignore alpha fall back to the AND mask
      if (rgba[s + 3] === 0) mask[row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(color.length + mask.length, 20);
  return Buffer.concat([header, color, mask]);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
if (!positional.length) die('no input file', USAGE);

if (flags.info) {
  for (const f of positional) info(f);
  process.exit(0);
}

const out = flags.out;
if (!out || out === true) die('no --out', USAGE);

const sources = [];
if (positional.length === 1) {
  const sizes = String(flags.sizes ?? '16,32,48').split(',').map(Number);
  for (const s of sizes) if (!Number.isInteger(s) || s < 1 || s > 256) die(`bad size: ${s}`);
  const { image } = await open(positional[0]);
  for (const size of sizes) sources.push({ size, image: image.clone().resize(size, size) });
} else {
  if (flags.sizes) die('--sizes works with a single input; several inputs keep their own sizes');
  for (const f of positional) {
    const { image, width } = await open(f);
    if (width > 256) die(`${f}: ${width}px, ICO holds 256 at most`);
    sources.push({ size: width, image });
  }
}
const sizes = sources.map((s) => s.size);
if (new Set(sizes).size !== sizes.length) die(`duplicate sizes: ${sizes.join(', ')}`);

const images = [];
for (const { size, image } of sources) {
  if (flags.png || size === 256) {
    images.push(await image.png().toBuffer());
  } else {
    const { data } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    images.push(bmp(data, size));
  }
}

const dir = Buffer.alloc(6 + 16 * images.length);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(images.length, 4);
let offset = dir.length;
images.forEach((data, i) => {
  const e = 6 + i * 16;
  dir[e] = dir[e + 1] = sizes[i] === 256 ? 0 : sizes[i];
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(data.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += data.length;
});

writeFileSync(String(out), Buffer.concat([dir, ...images]));
console.error(`written: ${out} (${sizes.join(', ')})`);
