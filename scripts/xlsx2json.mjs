#!/usr/bin/env node
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { parseArgs, die } from './_args.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
// codepage table: legacy .xls with non-latin text is garbled without it
XLSX.set_cptable(require('xlsx/dist/cpexcel.js'));

const USAGE = `usage: node xlsx2json.mjs <file.xlsx|.xls|.csv> [options]

  --list              only list sheet names and their dimensions
  --sheet <name|idx>  single sheet (name, or 0-based index)
  --csv               CSV instead of JSON
  --no-header         rows as arrays instead of objects keyed by the first row
  --formatted         cell text as Excel displays it (strings) instead of
                      the underlying typed values, which are the default
  --out <file>        write to file instead of stdout`;

const { positional, flags } = parseArgs(process.argv.slice(2));
const file = positional[0];
if (!file) die('no input file', USAGE);

const wb = XLSX.readFile(file, { cellDates: true, codepage: 65001 });

if (flags.list) {
  const rows = wb.SheetNames.map((name) => {
    const ref = wb.Sheets[name]['!ref'];
    const r = ref ? XLSX.utils.decode_range(ref) : null;
    return {
      name,
      rows: r ? r.e.r - r.s.r + 1 : 0,
      cols: r ? r.e.c - r.s.c + 1 : 0,
      ref: ref ?? null,
    };
  });
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

let names = wb.SheetNames;
if (flags.sheet !== undefined && flags.sheet !== true) {
  const sel = String(flags.sheet);
  const byIndex = /^\d+$/.test(sel) ? wb.SheetNames[Number(sel)] : undefined;
  const name = wb.SheetNames.includes(sel) ? sel : byIndex;
  if (!name) die(`sheet "${sel}" not found; have: ${wb.SheetNames.join(', ')}`);
  names = [name];
}

// typed values by default: numbers stay numbers, so downstream math works
const opts = { raw: !flags.formatted, defval: null };
if (flags['no-header']) opts.header = 1;

let out;
if (flags.csv) {
  out = names
    .map((n) => (names.length > 1 ? `# ${n}\n` : '') + XLSX.utils.sheet_to_csv(wb.Sheets[n]))
    .join('\n');
} else {
  const data = Object.fromEntries(
    names.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], opts)]),
  );
  out = JSON.stringify(names.length === 1 ? data[names[0]] : data, null, 2);
}

if (flags.out && flags.out !== true) {
  writeFileSync(String(flags.out), out, 'utf8');
  console.error(`written: ${flags.out}`);
} else {
  console.log(out);
}
