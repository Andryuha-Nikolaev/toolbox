#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseArgs, die } from './_args.mjs';

const require = createRequire(import.meta.url);
const { unzipSync, strFromU8 } = require('fflate');

const USAGE = `usage: node pptx-extract.mjs <file.pptx> [options]

  --json              structured JSON instead of a readable text report
  --media-dir <dir>   extract ppt/media there (image bytes, no conversion)
  --notes             include speaker notes
  --out <file>        write to file instead of stdout

Slide-to-image mapping comes from ppt/slides/_rels/slideN.xml.rels, never
from media filenames - those do not follow slide order.`;

const { positional, flags } = parseArgs(process.argv.slice(2));
const file = positional[0];
if (!file) die('no input file', USAGE);

const zip = unzipSync(new Uint8Array(readFileSync(file)));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);

const xml = (path) => (zip[path] ? strFromU8(zip[path]) : null);

// <a:p> is a paragraph, <a:t> a text run inside it; joining runs per paragraph
// keeps line structure that a flat <a:t> sweep would lose
function textOf(doc) {
  if (!doc) return [];
  return [...doc.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map((m) => [...m[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decode(t[1])).join(''))
    .filter((line) => line.trim() !== '');
}

const slideNum = (name) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

const slidePaths = Object.keys(zip)
  .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .sort((a, b) => slideNum(a) - slideNum(b));

if (slidePaths.length === 0) die(`no slides found in ${file} - is it really a .pptx?`);

const mediaDir = flags['media-dir'] !== true ? flags['media-dir'] : undefined;
if (mediaDir) mkdirSync(mediaDir, { recursive: true });

const slides = slidePaths.map((path) => {
  const n = slideNum(path);
  const rels = xml(`ppt/slides/_rels/slide${n}.xml.rels`) ?? '';
  const media = [...rels.matchAll(/Target="([^"]*media\/[^"]+)"/g)].map((m) =>
    m[1].replace(/^\.\.\//, 'ppt/'),
  );
  const notes = flags.notes ? textOf(xml(`ppt/notesSlides/notesSlide${n}.xml`)) : undefined;
  return { slide: n, text: textOf(xml(path)), media, ...(notes ? { notes } : {}) };
});

let extracted = 0;
if (mediaDir) {
  const wanted = new Set(slides.flatMap((s) => s.media));
  for (const path of wanted) {
    if (!zip[path]) {
      console.error(`[warn] referenced but missing in archive: ${path}`);
      continue;
    }
    writeFileSync(join(mediaDir, basename(path)), zip[path]);
    extracted++;
  }
}

let out;
if (flags.json) {
  out = JSON.stringify({ file, slides }, null, 2);
} else {
  out = slides
    .map((s) => {
      const head = `--- slide ${s.slide} ---`;
      const body = s.text.length ? s.text.join('\n') : '(no text)';
      const media = s.media.length ? `\n[media] ${s.media.map((p) => basename(p)).join(', ')}` : '';
      const notes = s.notes?.length ? `\n[notes] ${s.notes.join(' / ')}` : '';
      return `${head}\n${body}${media}${notes}`;
    })
    .join('\n\n');
}

console.error(
  `slides: ${slides.length}` + (mediaDir ? `, media extracted: ${extracted} -> ${mediaDir}` : ''),
);

if (flags.out && flags.out !== true) {
  writeFileSync(String(flags.out), out, 'utf8');
  console.error(`written: ${flags.out}`);
} else {
  console.log(out);
}
