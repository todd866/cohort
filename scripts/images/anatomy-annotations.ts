#!/usr/bin/env -S node --import tsx
/** Place vector labels over an immutable reviewed PNG. This is not a clinical approval gate. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

type Point = [number, number];
type Review = { status: 'draft' | 'agent-reviewed'; notes: string };
type PositionedText = { text: string; position: Point; align?: 'start' | 'middle' | 'end'; fontSize?: number };
export type AnatomyAnnotationSpec = {
  schemaVersion: 1;
  id: string;
  baseImage: { file: string; sha256: string; width: number; height: number; review: Review };
  regions: { id: string; name: string; polygon: Point[]; sources: { url: string; fact: string }[]; review: Review }[];
  labels: { id: string; text: string; anchor: Point; elbow: Point; textPosition: Point; targetRegion: string;
    align?: PositionedText['align']; fontSize?: number }[];
  title?: PositionedText;
  footer?: PositionedText;
  textBlocks?: PositionedText[];
};
export type AnnotationOptions = { rootDir?: string };
const EPSILON = 1e-7; // Pixel-distance tolerance; points this close to an edge are ambiguous.
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Anatomy annotations: ${message}`);
}
function fields(value: unknown, names: string[], label: string): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: object required`);
  for (const key of Object.keys(value)) ensure(names.includes(key), `${label}: unknown property ${key}`);
}
function nonempty(value: unknown, label: string): asserts value is string {
  ensure(typeof value === 'string' && value.trim().length > 0, `${label}: nonempty text required`);
  // XML 1.0 disallows control characters and unpaired UTF-16 surrogates.
  ensure([...value].every(char => {
    const c = char.codePointAt(0)!;
    return c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || c >= 0x10000;
  }), `${label}: invalid XML character`);
}
function identity(value: unknown, label: string) {
  ensure(typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value), `${label}: lowercase slug required`);
}
function review(value: unknown, label: string) {
  fields(value, ['status', 'notes'], label);
  ensure(value.status === 'agent-reviewed', `${label}: agent-reviewed status required; this is not clinician signoff`);
  nonempty(value.notes, `${label}.notes`);
}
function point(value: unknown, width: number, height: number, label: string): asserts value is Point {
  ensure(Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    && value[0] >= 0 && value[0] <= width && value[1] >= 0 && value[1] <= height, `${label}: coordinates outside finite canvas bounds`);
}
function typography(value: { align?: unknown; fontSize?: unknown }, label: string) {
  ensure(value.align === undefined || ['start', 'middle', 'end'].includes(value.align as string), `${label}: invalid text alignment`);
  ensure(value.fontSize === undefined || typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) && value.fontSize > 0,
    `${label}: positive finite fontSize required`);
}
function positionedText(value: unknown, width: number, height: number, label: string) {
  fields(value, ['text', 'position', 'align', 'fontSize'], label);
  nonempty(value.text, `${label}.text`); point(value.position, width, height, `${label}.position`); typography(value, label);
}

function relativePath(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !/[\\:\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'safe relative path required (no traversal, URI, controls, or backslashes)');
}
/** The explicitly selected root is canonicalized; every descendant must be a real path, never a symlink. */
function safePath(root: string, relative: string) {
  relativePath(relative);
  let current = root;
  const parts = relative.split('/');
  parts.forEach((part, index) => {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      ensure(!stat.isSymbolicLink(), `symlink path rejected: ${relative}`);
      if (index < parts.length - 1) ensure(stat.isDirectory(), `non-directory parent: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
  return current;
}
function inputBytes(root: string, relative: string) {
  const path = safePath(root, relative);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    ensure(before.isFile() && before.size <= MAX_INPUT_BYTES, 'input must be a regular file of at most 50 MiB');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathStat = lstatSync(safePath(root, relative));
    ensure(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs
      && pathStat.dev === after.dev && pathStat.ino === after.ino, 'input changed while being read');
    return bytes;
  } finally { closeSync(fd); }
}
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validatePng(bytes: Buffer, expected: AnatomyAnnotationSpec['baseImage']) {
  ensure(sha256(bytes) === expected.sha256, 'base image SHA-256 differs from the reviewed image');
  ensure(bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'PNG signature required');
  let offset = 8, seenHeader = false, seenData = false, endedData = false, seenEnd = false, seenPalette = false;
  let depth = 0, colour = 0, interlace = 0;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    ensure(offset + 12 <= bytes.length, 'PNG truncated chunk');
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    ensure(end <= bytes.length, 'PNG truncated chunk data');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    ensure(/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind), 'PNG invalid chunk type');
    ensure(crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4), 'PNG chunk CRC mismatch');
    ensure(!['acTL', 'fcTL', 'fdAT'].includes(kind), 'PNG must be a static reviewed image, not an animation');
    ensure(kind[0] === kind[0].toLowerCase() || ['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(kind), 'PNG unknown critical chunk');
    if (!seenHeader) {
      ensure(kind === 'IHDR' && size === 13, 'PNG must begin with one IHDR');
      ensure(bytes.readUInt32BE(offset + 8) === expected.width && bytes.readUInt32BE(offset + 12) === expected.height, 'base PNG dimensions differ from reviewed dimensions');
      depth = bytes[offset + 16]; colour = bytes[offset + 17]; interlace = bytes[offset + 20];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      ensure(depths[colour]?.includes(depth) && bytes[offset + 18] === 0 && bytes[offset + 19] === 0 && [0, 1].includes(interlace), 'PNG unsupported header colour, depth, or method');
      seenHeader = true;
    } else ensure(kind !== 'IHDR', 'PNG duplicate IHDR');
    if (kind === 'PLTE') {
      ensure(!seenPalette && compressed.length === 0 && ![0, 4].includes(colour) && size > 0 && size % 3 === 0 && size <= 768
        && (colour !== 3 || size / 3 <= 2 ** depth), 'PNG invalid or misplaced palette');
      seenPalette = true;
    }
    if (kind === 'IDAT') {
      ensure(!endedData, 'PNG IDAT chunks must be consecutive');
      ensure(colour !== 3 || seenPalette, 'PNG indexed image requires a preceding palette');
      compressed.push(bytes.subarray(offset + 8, end - 4));
      if (size > 0) seenData = true;
    } else if (seenData) endedData = true;
    if (kind === 'IEND') {
      ensure(size === 0 && seenData && end === bytes.length, 'PNG must end with IEND after image data');
      seenEnd = true;
    }
    offset = end;
  }
  ensure(seenEnd, 'PNG missing IEND');
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const scanlines = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((expected.width - x) / dx)), height = Math.max(0, Math.ceil((expected.height - y) / dy));
    return { rows: width ? height : 0, bytesPerRow: 1 + Math.ceil(width * channels[colour] * depth / 8) };
  });
  const expectedSize = scanlines.reduce((sum, pass) => sum + pass.rows * pass.bytesPerRow, 0);
  ensure(Number.isSafeInteger(expectedSize) && expectedSize > 0 && expectedSize <= 256 * 1024 * 1024, 'PNG decoded scanlines exceed 256 MiB limit');
  let decoded: Buffer;
  try { decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedSize }); }
  catch { throw new Error('Anatomy annotations: PNG image data cannot decode within expected scanline bounds'); }
  ensure(decoded.length === expectedSize, 'PNG decoded scanline size mismatch');
  let rowStart = 0;
  for (const pass of scanlines) for (let row = 0; row < pass.rows; row++) {
    ensure(decoded[rowStart] <= 4, 'PNG invalid scanline filter'); rowStart += pass.bytesPerRow;
  }
}

const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(p: Point, a: Point, b: Point) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length <= EPSILON) return Math.hypot(p[0] - a[0], p[1] - a[1]) <= EPSILON;
  const along = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length;
  return Math.abs(cross(a, b, p)) / length <= EPSILON && along >= -EPSILON && along <= length + EPSILON;
}
function intersects(a: Point, b: Point, c: Point, d: Point) {
  return onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b)
    || ((cross(a, b, c) > 0) !== (cross(a, b, d) > 0) && (cross(c, d, a) > 0) !== (cross(c, d, b) > 0));
}
function validatePolygon(polygon: unknown, width: number, height: number, label: string): asserts polygon is Point[] {
  ensure(Array.isArray(polygon) && polygon.length >= 3, `${label}: polygon requires at least three vertices`);
  polygon.forEach(p => point(p, width, height, `${label}.polygon`));
  const p = polygon as Point[];
  let twiceArea = 0;
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) ensure(Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]) > EPSILON, `${label}: polygon has repeated vertices`);
    const a = p[i], b = p[(i + 1) % p.length], c = p[(i + 2) % p.length];
    ensure(!onSegment(c, a, b) && !onSegment(a, b, c), `${label}: polygon has overlapping adjacent edges`);
    twiceArea += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 1; j < p.length; j++) {
      if (j === i + 1 || i === 0 && j === p.length - 1) continue;
      ensure(!intersects(a, b, p[j], p[(j + 1) % p.length]), `${label}: polygon self-intersects or touches itself`);
    }
  }
  ensure(Math.abs(twiceArea) > EPSILON, `${label}: polygon has zero or negligible area`);
}
function strictlyInside(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (onSegment(point, a, b)) return false;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function validateSpec(input: unknown): AnatomyAnnotationSpec {
  fields(input, ['schemaVersion', 'id', 'baseImage', 'regions', 'labels', 'title', 'footer', 'textBlocks'], 'specification');
  ensure(input.schemaVersion === 1, 'schemaVersion 1 required'); identity(input.id, 'id');
  fields(input.baseImage, ['file', 'sha256', 'width', 'height', 'review'], 'baseImage');
  const b = input.baseImage;
  relativePath(b.file); ensure(b.file.endsWith('.png'), 'baseImage.file must name a PNG');
  ensure(typeof b.sha256 === 'string' && /^[a-f0-9]{64}$/.test(b.sha256), 'baseImage.sha256 must be a lowercase SHA-256');
  ensure(Number.isSafeInteger(b.width) && (b.width as number) > 0 && Number.isSafeInteger(b.height) && (b.height as number) > 0,
    'baseImage dimensions must be positive safe integers');
  const width = b.width as number, height = b.height as number;
  review(b.review, 'baseImage.review');
  ensure(Array.isArray(input.regions) && input.regions.length > 0 && Array.isArray(input.labels) && input.labels.length > 0, 'at least one region and label required');
  const ids = new Set<string>(), regions = new Map<string, Point[]>();
  function unique(id: unknown) { identity(id, 'id'); ensure(!ids.has(id as string), `duplicate identity: ${id}`); ids.add(id as string); }
  for (const r of input.regions) {
    fields(r, ['id', 'name', 'polygon', 'sources', 'review'], 'region'); unique(r.id); nonempty(r.name, 'region.name');
    validatePolygon(r.polygon, width, height, r.id as string); review(r.review, `${r.id}.review`);
    ensure(Array.isArray(r.sources) && r.sources.length > 0, `${r.id}: source facts required`);
    for (const source of r.sources) {
      fields(source, ['url', 'fact'], `${r.id}.source`); nonempty(source.fact, `${r.id}.source.fact`);
      let url: URL | undefined;
      try { if (typeof source.url === 'string' && /^https:\/\/[^\s/@?#\\]+(?:[/?#][^\s\\]*)?$/i.test(source.url)) url = new URL(source.url); } catch { /* Invalid URL rejected below. */ }
      ensure(url && url.protocol === 'https:' && url.hostname && !url.username && !url.password, `${r.id}: valid HTTPS source URL without credentials required`);
    }
    regions.set(r.id as string, r.polygon);
  }
  for (const l of input.labels) {
    fields(l, ['id', 'text', 'anchor', 'elbow', 'textPosition', 'targetRegion', 'align', 'fontSize'], 'label');
    unique(l.id); nonempty(l.text, 'label.text'); typography(l, l.id as string);
    point(l.anchor, width, height, `${l.id}.anchor`); point(l.elbow, width, height, `${l.id}.elbow`); point(l.textPosition, width, height, `${l.id}.textPosition`);
    const polygon = regions.get(l.targetRegion as string);
    ensure(polygon, `${l.id}: unknown targetRegion ${l.targetRegion}`);
    ensure(strictlyInside(l.anchor, polygon), `${l.id}: anchor must be strictly inside ${l.targetRegion}; edges are ambiguous`);
  }
  if (input.title !== undefined) positionedText(input.title, width, height, 'title');
  if (input.footer !== undefined) positionedText(input.footer, width, height, 'footer');
  if (input.textBlocks !== undefined) {
    ensure(Array.isArray(input.textBlocks), 'textBlocks must be an array');
    input.textBlocks.forEach((value, index) => positionedText(value, width, height, `textBlocks[${index}]`));
  }
  return input as unknown as AnatomyAnnotationSpec;
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function renderAnatomyAnnotations(input: unknown, options: AnnotationOptions = {}) {
  const spec = structuredClone(validateSpec(input)), root = realpathSync(options.rootDir ?? process.cwd());
  const bytes = inputBytes(root, spec.baseImage.file); validatePng(bytes, spec.baseImage);
  const { width, height, file, sha256: digest } = spec.baseImage;
  const evidence = {
    schemaVersion: 1, tool: 'md3-anatomy-annotations', id: spec.id,
    baseImage: { file, sha256: digest, width, height }, specificationSha256: sha256(canonical(spec)),
    reviewStatus: 'agent-reviewed', clinicalReviewStatus: 'not-established-by-this-tool',
    boundaryPolicy: { classification: 'strict-interior', tolerancePixels: EPSILON },
    checks: ['base PNG SHA-256 and dimensions match reviewed record', 'safe regular input files; no symlink descendants',
      'static PNG header, chunk CRCs, bounded scanline decoding, and termination', 'unique region and label identities', 'simple bounded region polygons',
      'source facts and explicit agent review records', 'label anchors strictly inside named regions', 'all label and text coordinates within canvas'],
    anchorChecks: spec.labels.map(l => ({ labelId: l.id, targetRegion: l.targetRegion, anchor: l.anchor, result: 'strict-interior' })),
    limitations: ['Agent review is not clinician signoff.', 'This tool does not establish anatomical correctness, source adequacy, leader routing, text fit, or clinical suitability.'],
    provenance: spec,
  };
  const text = (t: PositionedText, size: number, weight = 500) => `<text x="${t.position[0]}" y="${t.position[1]}" text-anchor="${t.align ?? 'start'}" font-size="${t.fontSize ?? size}" font-weight="${weight}">${escape(t.text)}</text>`;
  const title = spec.title?.text ?? spec.id;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="diagram-title diagram-description">`,
    `<title id="diagram-title">${escape(title)}</title>`,
    '<desc id="diagram-description">Vector labels over an unchanged agent-reviewed image. Label placement and image integrity checked; clinical correctness not established by this tool.</desc>',
    `<metadata>${escape(canonical(evidence))}</metadata>`,
    `<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${bytes.toString('base64')}"/>`,
    '<g font-family="Arial, Helvetica, sans-serif" fill="#253746" stroke-linecap="round" stroke-linejoin="round">'];
  if (spec.title) out.push(text(spec.title, 36, 700));
  for (const t of spec.textBlocks ?? []) out.push(text(t, 24, 600));
  for (const l of spec.labels) {
    out.push(`<g id="label-${l.id}" data-target-region="${l.targetRegion}">`,
      `<polyline points="${[l.anchor, l.elbow, l.textPosition].map(p => p.join(',')).join(' ')}" fill="none" stroke="#253746" stroke-width="2"/>`,
      `<circle cx="${l.anchor[0]}" cy="${l.anchor[1]}" r="3"/>`,
      text({ text: l.text, position: l.textPosition, align: l.align, fontSize: l.fontSize }, 24), '</g>');
  }
  if (spec.footer) out.push(text(spec.footer, 18));
  out.push('</g>', '</svg>');
  const svg = out.join('\n') + '\n';
  return { svg, receipt: { ...evidence, svgSha256: sha256(svg) } };
}

/** Both destinations and all source validation are checked before the first write. Inputs are never opened for writing. */
export function writeAnatomyAnnotations(source: string, destination: string, options: AnnotationOptions = {}) {
  const root = realpathSync(options.rootDir ?? process.cwd());
  ensure(source.endsWith('.json') && destination.endsWith('.svg'), 'usage requires a JSON specification and SVG destination');
  const sourcePath = safePath(root, source);
  const specification = JSON.parse(inputBytes(root, source).toString('utf8'));
  const rendered = renderAnatomyAnnotations(specification, { rootDir: root });
  const basePath = safePath(root, specification.baseImage.file);
  const outputs = [safePath(root, destination), safePath(root, `${destination}.checks.json`)];
  for (const output of outputs) {
    ensure(output !== sourcePath && output !== basePath, 'output cannot overwrite an input');
    try {
      const stat = lstatSync(output);
      ensure(stat.isFile() && stat.nlink === 1, 'output must be a regular file with no hard links');
      for (const input of [sourcePath, basePath]) {
        const sourceStat = lstatSync(input);
        ensure(stat.dev !== sourceStat.dev || stat.ino !== sourceStat.ino, 'output aliases an input');
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  mkdirSync(dirname(outputs[0]), { recursive: true });
  const temporary: string[] = [];
  try {
    for (let i = 0; i < outputs.length; i++) {
      safePath(root, i === 0 ? destination : `${destination}.checks.json`);
      const temporaryPath = join(dirname(outputs[i]), `.anatomy-annotations-${randomUUID()}.tmp`);
      const fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      temporary.push(temporaryPath);
      try { writeFileSync(fd, i === 0 ? rendered.svg : JSON.stringify(rendered.receipt, null, 2) + '\n'); }
      finally { closeSync(fd); }
    }
    // Rename replaces the directory entry, never truncating an existing linked input.
    // The SVG/receipt are separate files: an interrupted pair is detectable via svgSha256.
    outputs.forEach((output, index) => {
      safePath(root, index === 0 ? destination : `${destination}.checks.json`);
      renameSync(temporary[index], output);
    });
  } finally { temporary.forEach(path => rmSync(path, { force: true })); }
  return rendered;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination, flag, rootDir, ...extra] = process.argv.slice(2);
  ensure(source && destination && (!flag || flag === '--root' && rootDir) && extra.length === 0,
    'Usage: anatomy-annotations.ts specification.json output.svg [--root directory]');
  const result = writeAnatomyAnnotations(source, destination, { rootDir });
  process.stdout.write(`${result.receipt.anchorChecks.length} verified label anchors; SVG ${result.receipt.svgSha256}; clinical acceptance remains separate\n`);
}
