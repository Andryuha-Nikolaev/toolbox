#!/usr/bin/env node
// PSD → layer tree (JSON + text) and per-layer PNG export. No canvas needed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { readPsd, getLayerImageData, getLayerMaskImageData, getCompositeImageData, initializeCanvas } from 'ag-psd';

// Pixel decoding only needs plain RGBA buffers; canvas itself is never used.
initializeCanvas(
	() => {
		throw new Error('canvas is not available in node');
	},
	(width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
);

const USAGE = `Usage: node psd-extract.mjs <file.psd> --out DIR [options]

Always writes DIR/tree.json and DIR/tree.txt (layer tree, bounds, texts, fonts).

Options:
  --png              export PNG for every matching pixel/text/smart layer (raw layer pixels:
                     clipped adjustment layers like Curves / Selective Color are NOT applied)
  --filter REGEX     only layers whose path matches (case-insensitive), e.g. "hero|about".
                     In Git Bash do not start REGEX with "/" — MSYS rewrites it into a path.
  --cutout REGEX     for every group/layer whose path matches: colors from the document
                     composite (all adjustments applied), alpha from the layers themselves.
                     Use it when --png colors differ from the layout. Edges keep a trace of
                     the background the element was placed on.
  --hidden           include hidden layers in the PNG export
  --min-size N       skip layers smaller than N px on both sides (default 4)
  --composite        export the document composite as composite.png
  --memory-mb N      bitmap decoding limit (default 4096)`;

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
	console.error(USAGE);
	process.exit(args.length ? 0 : 1);
}

const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(name);

const input = resolve(args[0]);
const outDir = opt('--out');
if (!outDir) {
	console.error('--out DIR is required\n\n' + USAGE);
	process.exit(1);
}
const filter = opt('--filter') ? new RegExp(opt('--filter'), 'i') : null;
const minSize = Number(opt('--min-size', 4));
const exportPng = flag('--png');
const withHidden = flag('--hidden');

mkdirSync(outDir, { recursive: true });

console.error(`reading ${input} ...`);
const started = Date.now();
// useRawData keeps bitmaps compressed until a layer is actually exported,
// otherwise a 500 MB file with hundreds of layers does not fit in memory.
const psd = readPsd(readFileSync(input), {
	useRawData: true,
	useRawThumbnail: true,
	skipLinkedFilesData: true,
	totalMemoryLimit: Number(opt('--memory-mb', 4096)) * 1024 * 1024,
});
console.error(`parsed in ${((Date.now() - started) / 1000).toFixed(1)}s: ${psd.width}x${psd.height}, ${psd.bitsPerChannel} bit`);

function kindOf(layer) {
	if (layer.children) return 'group';
	if (layer.text) return 'text';
	if (layer.placedLayer) return 'smart';
	if (layer.adjustment) return 'adjustment';
	if (layer.vectorOrigination || layer.vectorMask) return 'shape';
	return 'pixel';
}

// ag-psd lists every effect slot, including switched-off ones.
function enabledEffects(effects) {
	if (!effects || effects.disabled) return undefined;
	const on = Object.entries(effects)
		.filter(([key, value]) => {
			if (key === 'scale' || key === 'disabled') return false;
			const items = Array.isArray(value) ? value : [value];
			return items.some((item) => item && item.enabled !== false);
		})
		.map(([key]) => key);
	return on.length ? on : undefined;
}

function textInfo(text) {
	const scale = text.transform ? Math.abs(text.transform[3]) || 1 : 1;
	const size = (s) => (s?.fontSize ? Math.round(s.fontSize * scale * 100) / 100 : undefined);
	const runs = (text.styleRuns ?? []).map((r) => ({
		length: r.length,
		font: r.style?.font?.name,
		size: size(r.style),
		tracking: r.style?.tracking,
		leading: r.style?.autoLeading === false ? r.style?.leading : undefined,
		color: r.style?.fillColor,
	}));
	return {
		text: text.text,
		font: text.style?.font?.name ?? runs[0]?.font,
		size: size(text.style) ?? runs[0]?.size,
		fonts: [...new Set([text.style?.font?.name, ...runs.map((r) => r.font)].filter(Boolean))],
		runs,
	};
}

function describe(layer, parentPath, parentHidden) {
	const path = parentPath ? `${parentPath} / ${layer.name}` : layer.name;
	const hidden = Boolean(layer.hidden) || parentHidden;
	const node = {
		name: layer.name,
		path,
		kind: kindOf(layer),
		hidden,
		opacity: layer.opacity === undefined ? 1 : Math.round(layer.opacity * 100) / 100,
		blendMode: layer.blendMode,
		clipping: layer.clipping || undefined,
		bounds: { left: layer.left, top: layer.top, width: (layer.right ?? 0) - (layer.left ?? 0), height: (layer.bottom ?? 0) - (layer.top ?? 0) },
		mask: layer.mask ? true : undefined,
		effects: enabledEffects(layer.effects),
		text: layer.text ? textInfo(layer.text) : undefined,
		layer,
	};
	if (layer.children) {
		// PSD stores children bottom-to-top; the tree reads top-to-bottom like the Layers panel.
		node.children = [...layer.children].reverse().map((c) => describe(c, path, hidden));
		const b = node.children.filter((c) => c.bounds.width > 0).map((c) => c.bounds);
		if (b.length) {
			const left = Math.min(...b.map((x) => x.left));
			const top = Math.min(...b.map((x) => x.top));
			node.bounds = {
				left,
				top,
				width: Math.max(...b.map((x) => x.left + x.width)) - left,
				height: Math.max(...b.map((x) => x.top + x.height)) - top,
			};
		}
	}
	return node;
}

const tree = [...(psd.children ?? [])].reverse().map((l) => describe(l, '', false));

const strip = (node) => {
	const { layer, children, ...rest } = node;
	return children ? { ...rest, children: children.map(strip) } : rest;
};
writeFileSync(
	join(outDir, 'tree.json'),
	JSON.stringify({ file: input, width: psd.width, height: psd.height, bitsPerChannel: psd.bitsPerChannel, colorMode: psd.colorMode, layers: tree.map(strip) }, null, 1),
);

const lines = [];
const walk = (nodes, depth) => {
	for (const n of nodes) {
		const b = n.bounds;
		const meta = [
			n.kind,
			`${b.left},${b.top} ${b.width}x${b.height}`,
			n.hidden ? 'HIDDEN' : '',
			n.opacity < 1 ? `op=${n.opacity}` : '',
			n.blendMode && n.blendMode !== 'normal' && n.blendMode !== 'pass through' ? n.blendMode : '',
			n.clipping ? 'clip' : '',
			n.mask ? 'mask' : '',
			n.effects?.length ? `fx=${n.effects.join('+')}` : '',
		].filter(Boolean);
		lines.push(`${'  '.repeat(depth)}${n.name}  [${meta.join(' | ')}]`);
		if (n.text) {
			const t = n.text.text.replace(/\s+/g, ' ').trim();
			lines.push(`${'  '.repeat(depth + 1)}» ${t.length > 120 ? t.slice(0, 120) + '…' : t}  {${n.text.fonts.join(', ')} ${n.text.size ?? ''}}`);
		}
		if (n.children) walk(n.children, depth + 1);
	}
};
walk(tree, 0);
writeFileSync(join(outDir, 'tree.txt'), lines.join('\n') + '\n');
console.error(`tree: ${lines.length} lines → ${join(outDir, 'tree.txt')}`);

function encodePng({ data, width, height }) {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0;
		Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
	}
	const chunk = (type, body) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(body.length);
		const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 6 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

const safe = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, '-').slice(0, 80);

if (flag('--composite')) {
	const img = getCompositeImageData(psd);
	if (img) {
		writeFileSync(join(outDir, 'composite.png'), encodePng(img));
		console.error('composite.png written');
	} else console.error('no composite image in file (saved without "Maximize compatibility"?)');
}

if (exportPng) {
	const pngDir = join(outDir, 'layers');
	mkdirSync(pngDir, { recursive: true });
	const manifest = [];
	let index = 0;
	const exportWalk = (nodes) => {
		for (const n of nodes) {
			if (n.children) {
				exportWalk(n.children);
				continue;
			}
			if (n.hidden && !withHidden) continue;
			if (n.kind === 'adjustment') continue;
			if (filter && !filter.test(n.path)) continue;
			if (n.bounds.width < minSize && n.bounds.height < minSize) continue;
			const img = getLayerImageData(n.layer);
			if (!img) continue;
			// A single root artboard would prefix every file name with the same noise.
			const shortPath = tree.length === 1 ? n.path.slice(tree[0].name.length + 3) : n.path;
			const file = `${String(++index).padStart(3, '0')}_${safe(shortPath.replace(/ \/ /g, '__'))}.png`;
			writeFileSync(join(pngDir, file), encodePng(img));
			manifest.push({ file, path: n.path, kind: n.kind, bounds: n.bounds, hidden: n.hidden, opacity: n.opacity, blendMode: n.blendMode, clipping: n.clipping, mask: n.mask, effects: n.effects });
		}
	};
	exportWalk(tree);
	writeFileSync(join(pngDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
	console.error(`png: ${manifest.length} layers → ${pngDir}`);
}

// Coverage of one layer at document pixel (x, y), including its own mask and the masks
// and opacity of every ancestor group — the same factors Photoshop used for the composite.
function maskSampler(layer) {
	const mask = layer.mask;
	if (!mask || mask.disabled) return null;
	const data = getLayerMaskImageData(layer);
	const fallback = (mask.defaultColor ?? 0) / 255;
	const left = mask.left ?? 0;
	const top = mask.top ?? 0;
	const width = data?.width ?? 0;
	const height = data?.height ?? 0;
	return (x, y) => {
		const mx = x - left;
		const my = y - top;
		if (!data || mx < 0 || my < 0 || mx >= width || my >= height) return fallback;
		return data.data[(my * width + mx) * 4] / 255;
	};
}

function cutout(node, ancestors, composite) {
	const docW = psd.width;
	const docH = psd.height;
	const x0 = Math.max(0, node.bounds.left);
	const y0 = Math.max(0, node.bounds.top);
	const x1 = Math.min(docW, node.bounds.left + node.bounds.width);
	const y1 = Math.min(docH, node.bounds.top + node.bounds.height);
	const w = x1 - x0;
	const h = y1 - y0;
	if (w <= 0 || h <= 0) return null;
	const acc = new Float32Array(w * h);

	const visit = (n, chain) => {
		if (n.hidden) return;
		if (n.children) {
			const next = [...chain, { opacity: n.opacity, mask: maskSampler(n.layer) }];
			n.children.forEach((c) => visit(c, next));
			return;
		}
		// Adjustments carry no coverage; clipped layers never reach outside their base layer.
		if (n.kind === 'adjustment' || n.clipping) return;
		const img = getLayerImageData(n.layer);
		if (!img) return;
		const own = maskSampler(n.layer);
		const opacity = chain.reduce((o, g) => o * g.opacity, n.opacity);
		const lx0 = Math.max(x0, n.bounds.left);
		const ly0 = Math.max(y0, n.bounds.top);
		const lx1 = Math.min(x1, n.bounds.left + img.width);
		const ly1 = Math.min(y1, n.bounds.top + img.height);
		for (let y = ly0; y < ly1; y++) {
			for (let x = lx0; x < lx1; x++) {
				let a = (img.data[((y - n.bounds.top) * img.width + (x - n.bounds.left)) * 4 + 3] / 255) * opacity;
				if (a === 0) continue;
				if (own) a *= own(x, y);
				for (const g of chain) if (g.mask) a *= g.mask(x, y);
				const i = (y - y0) * w + (x - x0);
				acc[i] = 1 - (1 - acc[i]) * (1 - a);
			}
		}
	};
	visit(node, ancestors);

	// Trim fully transparent borders.
	let tx0 = w, ty0 = h, tx1 = -1, ty1 = -1;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			if (acc[y * w + x] > 1 / 255) {
				if (x < tx0) tx0 = x;
				if (x > tx1) tx1 = x;
				if (y < ty0) ty0 = y;
				if (y > ty1) ty1 = y;
			}
	if (tx1 < 0) return null;
	const ow = tx1 - tx0 + 1;
	const oh = ty1 - ty0 + 1;
	const out = new Uint8Array(ow * oh * 4);
	for (let y = 0; y < oh; y++) {
		for (let x = 0; x < ow; x++) {
			const dx = x0 + tx0 + x;
			const dy = y0 + ty0 + y;
			const s = (dy * docW + dx) * 4;
			const d = (y * ow + x) * 4;
			out[d] = composite.data[s];
			out[d + 1] = composite.data[s + 1];
			out[d + 2] = composite.data[s + 2];
			out[d + 3] = Math.round(acc[(ty0 + y) * w + tx0 + x] * 255);
		}
	}
	return { image: { width: ow, height: oh, data: out }, left: x0 + tx0, top: y0 + ty0 };
}

if (opt('--cutout')) {
	const re = new RegExp(opt('--cutout'), 'i');
	const composite = getCompositeImageData(psd);
	if (!composite) {
		console.error('--cutout needs the composite image (save the PSD with "Maximize compatibility")');
		process.exit(1);
	}
	const dir = join(outDir, 'cutouts');
	mkdirSync(dir, { recursive: true });
	const manifest = [];
	let index = 0;
	const walkCut = (nodes, chain) => {
		for (const n of nodes) {
			if (re.test(n.path)) {
				const res = cutout(n, chain, composite);
				if (res) {
					const shortPath = tree.length === 1 ? n.path.slice(tree[0].name.length + 3) : n.path;
					const file = `${String(++index).padStart(3, '0')}_${safe(shortPath.replace(/ \/ /g, '__'))}.png`;
					writeFileSync(join(dir, file), encodePng(res.image));
					manifest.push({ file, path: n.path, left: res.left, top: res.top, width: res.image.width, height: res.image.height });
				}
			}
			if (n.children) walkCut(n.children, [...chain, { opacity: n.opacity, mask: maskSampler(n.layer) }]);
		}
	};
	walkCut(tree, []);
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
	console.error(`cutouts: ${manifest.length} → ${dir}`);
}

console.error(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
