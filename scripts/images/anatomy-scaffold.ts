#!/usr/bin/env -S node --import tsx
/** Original anatomical relationship maps. Tests validate construction, never clinical accuracy. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Rect = { x: number; y: number; width: number; height: number };
type Region = { id: string; view: string; kind: 'lung' | 'mediastinum' | 'liver' | 'bowel'; parts: Rect[] };
type View = Rect & { id: string; title: string; projection: string; patientRight: string; superior: string; midline: number };
type Boundary = { id: string; view: string; y: number; extent: number[]; opening: number[] | null };
type Constraint = { type: string; a?: string; b?: string; region?: string; side?: string; boundary?: string; baseline?: string; shifted?: string; direction?: string };
export type AnatomyScaffold = {
  schemaVersion: number; id: string; title: string; license: string; status: string; teachingPoint: string;
  sources: { id: string; url: string; inspected: string }[]; views: View[]; regions: Region[]; boundaries: Boundary[];
  labels: { target: string; text: string; anchor: number[] }[]; constraints: Constraint[]; omissions: string[];
  locationMap: { x: number; y: number; width: number; height: number; title: string; projection: string;
    patientRight: string; anterior: string; midline: number; center: number[]; radii: number[];
    defect: { center: number[]; radii: number[] } };
};
const fail = (condition: unknown, message: string): void => { if (!condition) throw new Error(`Anatomy scaffold: ${message}`); };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
// A shared edge must have positive length. Corner-only contact cannot carry an organ.
const connects = (a: Rect, b: Rect) => {
  const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return dx >= 0 && dy >= 0 && (dx > 0 || dy > 0);
};
const finitePair = (p: number[]) => p?.length === 2 && p.every(Number.isFinite);
const contains = (r: Rect, p: number[]) => p[0] >= r.x && p[0] <= r.x + r.width && p[1] >= r.y && p[1] <= r.y + r.height;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export function validateAnatomyScaffold(input: unknown) {
  const s = input as AnatomyScaffold;
  fail(s?.schemaVersion === 1 && s.license === 'MIT' && s.status === 'construction-draft', 'explicit construction status and MIT required');
  fail(s.sources?.length > 0 && s.sources.every(x => /^https:\/\//.test(x.url) && x.inspected.trim()), 'inspected source evidence required');
  fail(s.views?.length === 2 && s.regions?.length > 0 && s.constraints?.length > 0, 'paired views and constraints required');
  const views = new Map(s.views.map(v => [v.id, v]));
  const regions = new Map(s.regions.map(r => [r.id, r]));
  const boundaries = new Map(s.boundaries.map(b => [b.id, b]));
  fail(views.size === s.views.length && regions.size === s.regions.length && boundaries.size === s.boundaries.length, 'duplicate identities');
  for (const v of s.views) {
    fail([v.x, v.y, v.width, v.height, v.midline].every(Number.isFinite)
      && v.width > 0 && v.height > 0 && v.midline > 0 && v.midline < v.width, 'invalid comparison frame');
    fail(v.projection === 'frontal-occupancy' && v.patientRight === 'viewer-left' && v.superior === 'up', 'frontal laterality mismatch');
    fail(v.width === s.views[0].width && v.height === s.views[0].height && v.midline === s.views[0].midline, 'fixed comparison frame or midline moved');
  }
  for (const r of s.regions) {
    const v = views.get(r.view);
    fail(v && r.parts.length > 0, `${r.id}: region requires view and parts`);
    for (const p of r.parts) {
      fail([p.x, p.y, p.width, p.height].every(Number.isFinite) && p.width > 0 && p.height > 0
        && p.x >= 0 && p.y >= 0 && p.x + p.width <= v!.width && p.y + p.height <= v!.height, `${r.id}: invalid region bounds`);
    }
  }
  for (const b of s.boundaries) {
    const v = views.get(b.view);
    fail(v && b.extent.length === 2 && b.extent[0] >= 0 && b.extent[1] <= v!.width && b.extent[0] < b.extent[1]
      && b.y > 0 && b.y < v!.height, 'boundary out of frame');
    fail(!b.opening || b.opening.length === 2 && b.opening[0] > b.extent[0] && b.opening[1] < b.extent[1]
      && b.opening[0] < b.opening[1], 'invalid opening');
  }
  const checks: string[] = ['explicit projections and fixed comparison frame', 'named bounded regions'];
  for (const c of s.constraints) {
    const r = regions.get(c.region ?? c.a ?? c.shifted ?? '');
    fail(r, `unknown constrained region ${c.region ?? c.a ?? c.shifted}`);
    const v = views.get(r!.view)!;
    const boundary = boundaries.get(c.boundary ?? '');
    if (c.type === 'disjoint') {
      const b = regions.get(c.b!); fail(b && b.view === r!.view, 'disjoint constraint needs same view');
      fail(!r!.parts.some(a => b!.parts.some(b => overlaps(a, b))), `${r!.id} overlaps ${b!.id}`);
    } else if (c.type === 'side') {
      fail(['left', 'right'].includes(c.side!), 'unknown patient side');
      fail(r!.parts.every(p => c.side === 'left' ? p.x >= v.midline : p.x + p.width <= v.midline), `${r!.id}: wrong patient side`);
    } else if (c.type === 'above' || c.type === 'below') {
      fail(boundary?.view === r!.view, 'boundary constraint needs same view');
      fail(r!.parts.every(p => c.type === 'above' ? p.y + p.height < boundary!.y : p.y > boundary!.y), `${r!.id}: wrong diaphragm compartment`);
    } else if (c.type === 'connected') {
      const reached = new Set([0]);
      for (let size = -1; size !== reached.size;) {
        size = reached.size;
        r!.parts.forEach((p, i) => { if ([...reached].some(j => connects(p, r!.parts[j]))) reached.add(i); });
      }
      fail(reached.size === r!.parts.length, `${r!.id}: disconnected occupancy`);
    } else if (c.type === 'through-opening') {
      fail(boundary?.view === r!.view && boundary.opening, 'communication requires an opening in same view');
      // Include parts ending on the line: two joined parts may span the boundary
      // without either rectangle strictly straddling it.
      const crossing = r!.parts.filter(p => p.y <= boundary!.y && p.y + p.height >= boundary!.y);
      fail(crossing.length > 0 && crossing.every(p => p.x > boundary!.opening![0] && p.x + p.width < boundary!.opening![1]), `${r!.id}: intersects intact diaphragm`);
      fail(r!.parts.some(p => p.y + p.height < boundary!.y) && r!.parts.some(p => p.y > boundary!.y), 'communication must reach both compartments');
    } else if (c.type === 'shift') {
      const original = regions.get(c.baseline!);
      fail(c.direction === 'patient-right' && original && r!.parts.length === 1 && original.parts.length === 1, 'unsupported displacement contract');
      const a = original!.parts[0], b = r!.parts[0];
      fail(b.x < a.x && b.y === a.y && b.width === a.width && b.height === a.height, 'mediastinum must translate toward patient right');
    } else throw new Error(`Anatomy scaffold: unknown constraint ${c.type}`);
    checks.push(`${c.type}: ${r!.id}`);
  }
  for (const label of s.labels) {
    const r = regions.get(label.target);
    fail(label.text.trim() && label.anchor.length === 2 && r?.parts.some(p => contains(p, label.anchor)), `label target outside ${label.target}`);
  }
  const m = s.locationMap;
  fail(m?.projection === 'caudal' && m.patientRight === 'viewer-left' && m.anterior === 'up', 'caudal orientation mismatch');
  fail([m.x, m.y, m.width, m.height, m.midline].every(Number.isFinite)
    && m.width > 0 && m.height > 0 && m.midline > 0 && m.midline < m.width, 'invalid caudal frame');
  for (const ellipse of [m, m.defect]) {
    fail(finitePair(ellipse.center) && finitePair(ellipse.radii) && ellipse.radii.every(r => r > 0), 'invalid ellipse geometry');
    fail(ellipse.center[0] - ellipse.radii[0] >= 0 && ellipse.center[0] + ellipse.radii[0] <= m.width
      && ellipse.center[1] - ellipse.radii[1] >= 0 && ellipse.center[1] + ellipse.radii[1] <= m.height, 'ellipse outside caudal frame');
  }
  fail(m.midline === m.center[0], 'caudal midline must bisect the symbolic perimeter');
  fail(m.defect.center[0] - m.defect.radii[0] > m.midline && m.defect.center[1] - m.defect.radii[1] > m.center[1], 'defect must be posterior and patient-left');
  // The illustrative aperture must remain inside the symbolic diaphragm perimeter.
  for (let i = 0; i < 360; i++) {
    const a = i * Math.PI / 180;
    const x = m.defect.center[0] + m.defect.radii[0] * Math.cos(a);
    const y = m.defect.center[1] + m.defect.radii[1] * Math.sin(a);
    fail(((x - m.center[0]) / m.radii[0]) ** 2 + ((y - m.center[1]) / m.radii[1]) ** 2 < 1, 'aperture outside diaphragm outline');
  }
  checks.push('label anchors within named regions', 'posterior-left aperture in explicit caudal view');
  return { checks, geometrySha256: hash({ views: s.views, regions: s.regions, boundaries: s.boundaries, labels: s.labels, locationMap: s.locationMap, constraints: s.constraints }) };
}

const PALETTES = {
  paper: { lung: '#cbe0e6', mediastinum: '#d8c5d9', liver: '#e5c7a0', bowel: '#f4db92', ink: '#233645', boundary: '#806143', background: '#fffdf7' },
  contrast: { lung: '#bddbf5', mediastinum: '#edc9e1', liver: '#f5c690', bowel: '#ffe5a1', ink: '#10243a', boundary: '#463425', background: '#ffffff' },
};
export function renderAnatomyScaffold(input: unknown, palette: keyof typeof PALETTES = 'paper') {
  const report = validateAnatomyScaffold(input), s = input as AnatomyScaffold, p = PALETTES[palette];
  fail(p, 'unknown palette');
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="940" viewBox="0 0 1200 940" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escape(s.title)} — structural schematic</title><desc id="desc">${escape(s.teachingPoint)} Construction draft; not clinical validation.</desc>`,
    `<metadata>${escape(JSON.stringify({ license: s.license, status: s.status, geometrySha256: report.geometrySha256, sources: s.sources }))}</metadata>`,
    `<style>text{font-family:Arial,sans-serif;fill:${p.ink}}.title{font-size:31px;font-weight:700}.heading{font-size:22px;font-weight:700}.body{font-size:17px}.small{font-size:14px}.label{font-size:15px;font-weight:600}.axis{stroke:${p.ink};stroke-width:1.5;stroke-dasharray:5 5}</style>`,
    `<rect width="1200" height="940" fill="${p.background}"/><text x="35" y="45" class="title">${escape(s.title)}</text>`,
    `<text x="35" y="78" class="body">Structural construction • Schematic compartments • Not to scale</text>`];
  const text = (x: number, y: number, t: string, cls = 'body', anchor = 'start') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${escape(t)}</text>`;
  for (const v of s.views) {
    out.push(`<g transform="translate(${v.x} ${v.y})">`, text(0, -70, v.title, 'heading'), text(0, -45, 'Frontal occupancy map — not a section', 'small'),
      text(10, -15, 'Patient RIGHT', 'small'), text(240, -15, 'Patient LEFT', 'small'),
      `<rect width="${v.width}" height="${v.height}" rx="25" fill="none" stroke="${p.ink}" stroke-width="2"/>`,
      `<line x1="${v.midline}" x2="${v.midline}" y1="0" y2="${v.height}" class="axis"/>`);
    if (v.id === 'cdh') {
      const r = s.regions.find(r => r.id === 'baseline-mediastinum')!.parts[0];
      const moved = s.regions.find(r => r.id === 'cdh-mediastinum')!.parts[0];
      const arrowFrom = r.x + r.width / 2, arrowTo = moved.x + moved.width / 2, arrowY = Math.min(r.y, moved.y) - 20;
      out.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="${p.ink}" stroke-dasharray="4 4"/>`,
        `<path d="M${arrowFrom} ${arrowY}H${arrowTo}m0 0 9-6m-9 6 9 6" fill="none" stroke="${p.ink}" stroke-width="3"/>`);
    }
    for (const r of s.regions.filter(r => r.view === v.id)) {
      // Union parts are filled before an outline is added; no invented bowel wall or lumen.
      out.push(`<g id="${escape(r.id)}" fill="${p[r.kind]}">`);
      for (const q of r.parts) out.push(`<rect x="${q.x}" y="${q.y}" width="${q.width}" height="${q.height}"/>`);
      out.push('</g>');
    }
    for (const b of s.boundaries.filter(b => b.view === v.id)) {
      const intervals = b.opening ? [[b.extent[0], b.opening[0]], [b.opening[1], b.extent[1]]] : [b.extent];
      for (const [x1, x2] of intervals) out.push(`<line x1="${x1}" y1="${b.y}" x2="${x2}" y2="${b.y}" stroke="${p.boundary}" stroke-width="7"/>`);
      out.push(text(15, b.y + 27, 'Diaphragm boundary (projection)', 'small'));
    }
    for (const l of s.labels.filter(l => s.regions.find(r => r.id === l.target)?.view === v.id)) {
      const target = s.regions.find(r => r.id === l.target)!;
      if (target.kind === 'mediastinum') {
        out.push(`<text x="${l.anchor[0]}" y="${l.anchor[1]}" class="label" text-anchor="middle" transform="rotate(-90 ${l.anchor[0]} ${l.anchor[1]})">${escape(l.text)}</text>`);
        continue;
      }
      const width = target.parts.find(q => contains(q, l.anchor))!.width;
      const maxCharacters = Math.max(6, Math.floor(width / 8));
      const words = l.text.split(' '), lines: string[] = [];
      for (const word of words) { if (!lines.length || (lines[lines.length - 1] + ' ' + word).length > maxCharacters) lines.push(word); else lines[lines.length - 1] += ` ${word}`; }
      lines.forEach((line, i) => out.push(text(l.anchor[0], l.anchor[1] + (i - (lines.length - 1) / 2) * 19, line, 'label', 'middle')));
    }
    out.push('</g>');
  }
  const m = s.locationMap;
  out.push(`<g transform="translate(${m.x} ${m.y})">`, text(0, -75, m.title, 'heading'), text(0, -50, 'Caudal view — looking toward chest', 'small'),
    text(m.midline, 0, 'ANTERIOR', 'body', 'middle'), `<ellipse cx="${m.center[0]}" cy="${m.center[1]}" rx="${m.radii[0]}" ry="${m.radii[1]}" fill="${p.liver}" stroke="${p.boundary}" stroke-width="3"/>`,
    `<line x1="${m.midline}" x2="${m.midline}" y1="30" y2="240" class="axis"/>`,
    `<ellipse cx="${m.defect.center[0]}" cy="${m.defect.center[1]}" rx="${m.defect.radii[0]}" ry="${m.defect.radii[1]}" fill="${p.background}" stroke="${p.boundary}" stroke-width="3"/>`,
    text(10, 135, 'R', 'body', 'middle'), text(300, 135, 'L', 'body', 'middle'), text(m.midline, 265, 'POSTERIOR', 'body', 'middle'),
    text(0, 315, 'Selected posterior-left opening', 'body'), text(0, 340, 'Other apertures omitted.', 'small'), text(0, 365, 'Shape and size are illustrative.', 'small'), '</g>');
  out.push(text(35, 690, 'Bowel connects abdomen to left thorax through the gap, remaining outside the left lung.'),
    text(35, 721, 'Fixed dashed line = body midline. Dashed box = original mediastinal position.'),
    text(35, 752, 'Posterior location is established by the separate caudal map. Blocks are not organ contours.'));
  s.omissions.slice(0, 5).forEach((t, i) => out.push(text(35, 793 + i * 23, t, 'small')));
  out.push(text(35, 925, 'MD3 contributors • MIT • Construction draft • Source and geometry record embedded in SVG', 'small'), '</svg>');
  return { ...report, svg: out.join('\n') + '\n' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination || !destination.endsWith('.svg')) throw new Error('Usage: anatomy-scaffold.ts source.json output.svg');
  const rendered = renderAnatomyScaffold(JSON.parse(readFileSync(source, 'utf8')));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, rendered.svg);
  writeFileSync(`${destination}.checks.json`, JSON.stringify({ geometrySha256: rendered.geometrySha256, checks: rendered.checks }, null, 2) + '\n');
  process.stdout.write(`${rendered.checks.length} structural checks; ${rendered.geometrySha256}\n`);
}
