#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, die } from './_args.mjs';

const require = createRequire(import.meta.url);
const { marked } = require('marked');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
} = require('docx');

const USAGE = `usage: node md2docx.mjs <file.md> --out <file.docx> [options]

  --out <file>     output .docx (required)
  --title <text>   document title metadata

Covers headings, paragraphs, bold/italic/code/links, lists, tables,
blockquotes, code blocks and rules. Anything fancier - write an ad-hoc
script against the docx package directly.`;

const { positional, flags } = parseArgs(process.argv.slice(2));
const file = positional[0];
if (!file) die('no input file', USAGE);
if (!flags.out || flags.out === true) die('--out is required', USAGE);

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

function runs(tokens, style = {}) {
  const out = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...runs(t.tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...runs(t.tokens, { ...style, italics: true }));
        break;
      case 'del':
        out.push(...runs(t.tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        out.push(new TextRun({ text: t.text, font: 'Consolas', ...style }));
        break;
      case 'link':
        out.push(
          new ExternalHyperlink({
            link: t.href,
            children: runs(t.tokens, { ...style, style: 'Hyperlink' }),
          }),
        );
        break;
      case 'br':
        out.push(new TextRun({ text: '', break: 1 }));
        break;
      case 'image':
        out.push(new TextRun({ text: `[image: ${t.text || t.href}]`, italics: true }));
        break;
      default:
        out.push(new TextRun({ text: t.text ?? t.raw ?? '', ...style }));
    }
  }
  return out;
}

// Each ordered list gets its own numbering reference; sharing one would make
// the counter run on across separate lists instead of restarting at 1.
const numbering = [];

function orderedRef(start) {
  const reference = `ol${numbering.length}`;
  numbering.push({
    reference,
    levels: [0, 1, 2, 3].map((level) => ({
      level,
      format: 'decimal',
      text: `%${level + 1}.`,
      alignment: AlignmentType.START,
      start,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    })),
  });
  return reference;
}

function listItems(token, depth = 0, reference = null) {
  const ref = token.ordered ? (reference ?? orderedRef(token.start ?? 1)) : null;
  const out = [];
  for (const item of token.items) {
    const inline = item.tokens?.filter((t) => t.type !== 'list') ?? [];
    out.push(
      new Paragraph({
        children: runs(inline.flatMap((t) => t.tokens ?? [t])),
        ...(ref
          ? { numbering: { reference: ref, level: depth } }
          : { bullet: { level: depth } }),
      }),
    );
    for (const nested of item.tokens?.filter((t) => t.type === 'list') ?? []) {
      out.push(...listItems(nested, depth + 1, nested.ordered === token.ordered ? ref : null));
    }
  }
  return out;
}

function cell(tokens, header, align) {
  return new TableCell({
    children: [
      new Paragraph({
        children: runs(tokens, header ? { bold: true } : {}),
        alignment:
          align === 'center'
            ? AlignmentType.CENTER
            : align === 'right'
              ? AlignmentType.RIGHT
              : undefined,
      }),
    ],
  });
}

function convert(tokens) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        out.push(new Paragraph({ children: runs(t.tokens), heading: HEADINGS[t.depth - 1] }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ children: runs(t.tokens) }));
        break;
      case 'list':
        out.push(...listItems(t));
        break;
      case 'code':
        for (const line of t.text.split('\n')) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line, font: 'Consolas', size: 20 })],
              shading: { fill: 'F2F2F2' },
            }),
          );
        }
        break;
      case 'blockquote':
        for (const p of convert(t.tokens)) {
          p.options = { ...p.options, indent: { left: 720 } };
          out.push(p);
        }
        break;
      case 'table':
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: t.header.map((h, i) => cell(h.tokens, true, t.align?.[i])),
              }),
              ...t.rows.map(
                (row) =>
                  new TableRow({ children: row.map((c, i) => cell(c.tokens, false, t.align?.[i])) }),
              ),
            ],
          }),
        );
        out.push(new Paragraph({ text: '' }));
        break;
      case 'hr':
        out.push(new Paragraph({ text: '', border: { bottom: { style: 'single', size: 6 } } }));
        break;
      case 'space':
        break;
      default:
        if (t.tokens) out.push(new Paragraph({ children: runs(t.tokens) }));
        else if (t.text) out.push(new Paragraph({ text: t.text }));
    }
  }
  return out;
}

const md = readFileSync(file, 'utf8');
const children = convert(marked.lexer(md));

const doc = new Document({
  title: flags.title && flags.title !== true ? String(flags.title) : undefined,
  numbering: { config: numbering },
  sections: [{ children }],
});

writeFileSync(String(flags.out), await Packer.toBuffer(doc));
console.error(`written: ${flags.out} (${children.length} blocks)`);
