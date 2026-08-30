#!/usr/bin/env node
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parseArgs, die } from './_args.mjs';

const require = createRequire(import.meta.url);
const mammoth = require('mammoth');
const TurndownService = require('turndown');
const { gfm } = require('@joplin/turndown-plugin-gfm');

const USAGE = `usage: node docx2md.mjs <file.docx> [options]

  --html              HTML instead of Markdown
  --media-dir <dir>   extract embedded images there and link them
                      (without it images are dropped, keeping output readable)
  --out <file>        write to file instead of stdout`;

const { positional, flags } = parseArgs(process.argv.slice(2));
const file = positional[0];
if (!file) die('no input file', USAGE);

const mediaDir = flags['media-dir'] !== true ? flags['media-dir'] : undefined;
let imageCount = 0;

if (mediaDir) mkdirSync(mediaDir, { recursive: true });

const EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/x-emf': '.emf',
  'image/x-wmf': '.wmf',
};

const convertImage = mediaDir
  ? mammoth.images.imgElement(async (image) => {
      const buf = await image.read();
      const ext = EXT[image.contentType] ?? '.bin';
      const name = `image${++imageCount}${ext}`;
      writeFileSync(join(mediaDir, name), buf);
      return { src: join(mediaDir, name).split(sep).join('/') };
    })
  : mammoth.images.imgElement(() => {
      imageCount++;
      return { src: '' };
    });

const { value: html, messages } = await mammoth.convertToHtml({ path: file }, { convertImage });

for (const m of messages) console.error(`[mammoth:${m.type}] ${m.message}`);

let out = html;
if (!flags.html) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  if (!mediaDir) td.addRule('dropImages', { filter: 'img', replacement: () => '' });
  out = td.turndown(html);
}

console.error(`images: ${imageCount}${mediaDir ? ` -> ${mediaDir}` : ' (dropped)'}`);

if (flags.out && flags.out !== true) {
  writeFileSync(String(flags.out), out, 'utf8');
  console.error(`written: ${flags.out}`);
} else {
  console.log(out);
}
