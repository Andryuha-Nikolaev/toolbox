#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { parseArgs, die } from './_args.mjs';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

const USAGE = `usage: node frames2video.mjs <frames dir> --out <file.mp4> [--fps 30] [--width 1280] [--crf 20]
       node frames2video.mjs <frames dir> --sheet <file.png> [--every N | --count N] [--cols 6] [--width 320]
       [--from N] [--to N]

  <frames dir>    numbered pictures 00001.png, 00002.png… (the same digits in every name)
  --out <file>    H.264 video, yuv420p: plays in browsers and players
  --fps <n>       frame rate of the pictures, default 30
  --width <n>     output width, the height keeps the aspect; video default 1280, sheet tile default 320
  --crf <n>       x264 quality, lower is better, default 20
  --sheet <file>  one picture with a grid of frames, to look through a run fast
  --every <n>     every n-th frame on the sheet; or --count: that many frames spread evenly, default 24
  --cols <n>      tiles per row, default 6
  --from, --to    frame numbers to take, inclusive; default all`;

const { positional, flags } = parseArgs(process.argv.slice(2));
if (positional.length !== 1 || (!flags.out && !flags.sheet)) die('give a frames folder and --out or --sheet', USAGE);

const dir = resolve(positional[0]);
const names = readdirSync(dir).filter((n) => /^\d+\.png$/i.test(n)).sort();
if (names.length === 0) die(`${dir}: no numbered .png frames`);
const digits = names[0].length - 4;
if (names.some((n) => n.length - 4 !== digits)) die(`${dir}: frame names have different numbers of digits`);
const numbers = names.map((n) => Number.parseInt(n, 10));
const from = Number(flags.from ?? numbers[0]);
const to = Number(flags.to ?? numbers.at(-1));
const taken = numbers.filter((n) => n >= from && n <= to);
if (taken.length === 0) die(`no frames between ${from} and ${to}`);
const input = ['-start_number', String(taken[0]), '-i', join(dir, `%0${digits}d.png`), '-frames:v'];

function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) die(`ffmpeg exited with ${result.status}`);
}

if (flags.out) {
  const out = resolve(flags.out);
  mkdirSync(dirname(out), { recursive: true });
  const fps = String(flags.fps ?? 30);
  const width = Number(flags.width ?? 1280);
  // -2 keeps the height even, which yuv420p needs.
  run(['-framerate', fps, ...input, String(taken.length), '-vf', `scale=${width}:-2,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(flags.crf ?? 20), '-movflags', '+faststart', out]);
  console.log(`${out}: ${taken.length} frames, ${(taken.length / Number(fps)).toFixed(2)} s at ${fps} fps, width ${width}`);
}

if (flags.sheet) {
  const out = resolve(flags.sheet);
  mkdirSync(dirname(out), { recursive: true });
  const every = flags.every ? Number(flags.every) : Math.max(1, Math.ceil(taken.length / Number(flags.count ?? 24)));
  const picked = taken.filter((_, i) => i % every === 0);
  const cols = Math.min(Number(flags.cols ?? 6), picked.length);
  const rows = Math.ceil(picked.length / cols);
  const width = Number(flags.width ?? 320);
  // select counts from the first frame read, so n is the index within the taken range.
  run([...input, String(taken.length), '-vf',
    `select='not(mod(n\\,${every}))',scale=${width}:-1,tile=${cols}x${rows}:padding=4:color=white`,
    '-fps_mode', 'passthrough', '-frames:v', '1', out]);
  console.log(`${out}: ${picked.length} frames in ${cols}x${rows}, left to right, top to bottom:`);
  console.log(picked.join(' '));
}
