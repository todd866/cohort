import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../../../open-content/anatomy-scaffolds/focus-figures/manifest.json';
import { ANATOMY_FOCUS_TARGETS, isAnatomyFocusFigureId, isAnatomyFigureSelection } from '@/lib/cohort/anatomy-figure-catalogue';

export interface FocusFigureTarget { label: string; anchor: [number, number]; marker: [number, number] }
export interface FocusFigure {
  id: string; file: string; sha256: string; width: number; height: number;
  orientation: string; sourceUrl: string; sourceSha256: string;
  attribution: string; licence: 'CC-BY-3.0' | 'CC-BY-4.0';
  targets: Record<string, FocusFigureTarget>;
  review: { status: 'accepted' | 'pending'; reviewer: string; claims: string[]; specificationSha256: string };
}
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]!));
const SHA256 = /^[a-f0-9]{64}$/;
const HTTPS = /^https:\/\/[^\s]+$/i;

/** Exact reviewed annotation binding: geometry, labels, orientation, dimensions and source metadata. */
export function focusFigureSpecificationHash(figure: Pick<FocusFigure, 'id' | 'orientation' | 'width' | 'height' | 'sourceUrl' | 'sourceSha256' | 'attribution' | 'licence' | 'targets'>): string {
  const targets = Object.fromEntries(Object.entries(figure.targets).sort(([a], [b]) => a.localeCompare(b)).map(([id, target]) => [id, {
    label: target.label, anchor: [...target.anchor], marker: [...target.marker],
  }]));
  return createHash('sha256').update(JSON.stringify({
    id: figure.id, file: (figure as FocusFigure).file, sha256: (figure as FocusFigure).sha256,
    orientation: figure.orientation, width: figure.width, height: figure.height,
    sourceUrl: figure.sourceUrl, sourceSha256: figure.sourceSha256, attribution: figure.attribution,
    licence: figure.licence, targets,
  })).digest('hex');
}

function validPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1);
}
function validFigure(figure: FocusFigure): boolean {
  if (!figure || typeof figure !== 'object' || !isAnatomyFocusFigureId(figure.id) || typeof figure.file !== 'string' || !/^[a-z0-9-]+\.png$/.test(figure.file)
    || !SHA256.test(figure.sha256) || !SHA256.test(figure.sourceSha256)
    || !Number.isInteger(figure.width) || !Number.isInteger(figure.height) || figure.width < 1 || figure.height < 1
    || typeof figure.orientation !== 'string' || !figure.orientation.trim()
    || !HTTPS.test(figure.sourceUrl) || typeof figure.attribution !== 'string' || !figure.attribution.trim()
    || !['CC-BY-3.0', 'CC-BY-4.0'].includes(figure.licence) || !figure.review || typeof figure.review !== 'object' || figure.review.status !== 'accepted'
    || typeof figure.review.reviewer !== 'string' || !figure.review.reviewer.trim()
    || !Array.isArray(figure.review.claims) || !figure.review.claims.length || figure.review.claims.some(claim => typeof claim !== 'string' || !claim.trim())
    || !SHA256.test(figure.review.specificationSha256)) return false;
  if (!figure.targets || typeof figure.targets !== 'object' || Array.isArray(figure.targets)) return false;
  let specificationHash: string;
  try { specificationHash = focusFigureSpecificationHash(figure); } catch { return false; }
  if (figure.review.specificationSha256 !== specificationHash) return false;
  const allowed = ANATOMY_FOCUS_TARGETS[figure.id] as readonly string[];
  const targetEntries = Object.entries(figure.targets ?? {});
  if (targetEntries.length !== allowed.length || targetEntries.some(([id]) => !allowed.includes(id))) return false;
  return targetEntries.every(([, target]) => typeof target.label === 'string' && target.label.trim() && validPoint(target.anchor) && validPoint(target.marker));
}

/** An annotation is admitted only with an accepted review bound to its exact specification and base bytes. */
export function anatomyFocusSvg(id: unknown, target: unknown, phase: unknown, options: {
  entries?: readonly FocusFigure[]; read?: (file: string) => Uint8Array;
} = {}): string | null {
  if (!isAnatomyFocusFigureId(id) || typeof target !== 'string'
    || !isAnatomyFigureSelection(id, target, 'prompt') || !['prompt', 'answer'].includes(String(phase))) return null;
  const entries = options.entries ?? manifest.figures as unknown as FocusFigure[];
  if (!Array.isArray(entries) || entries.some(figure => !figure || typeof figure !== 'object' || Array.isArray(figure))) return null;
  const matches = entries.filter(figure => figure.id === id);
  if (matches.length !== 1 || !validFigure(matches[0])) return null;
  const f = matches[0], t = f.targets[target];
  if (!t) return null;
  try {
    const bytes = (options.read ?? (file => readFileSync(join(process.cwd(), 'open-content/anatomy-scaffolds/focus-figures', file))))(f.file);
    if (!(bytes instanceof Uint8Array) || createHash('sha256').update(bytes).digest('hex') !== f.sha256) return null;
    const x = t.anchor[0] * f.width, y = t.anchor[1] * f.height;
    const mx = t.marker[0] * f.width, my = t.marker[1] * f.height;
    const unit = Math.min(f.width, f.height), radius = f.width * 0.03;
    const footerHeight = f.width * (phase === 'answer' ? .15 : .09);
    const captionSize = f.width * .036;
    const caption = phase === 'answer' ? t.label : 'Structure A';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.width} ${f.height + footerHeight}" role="img"><title>${escape(caption)}</title><desc>${escape(f.orientation)}</desc><metadata>${escape(`${f.attribution}. ${f.licence} (https://creativecommons.org/licenses/by/${f.licence === 'CC-BY-4.0' ? '4.0' : '3.0'}/). Source: ${f.sourceUrl}. Image-generation adaptation; reviewed target overlay added.`)}</metadata><rect width="100%" height="100%" fill="white"/><image width="${f.width}" height="${f.height}" href="data:image/png;base64,${Buffer.from(bytes).toString('base64')}"/><path d="M ${mx} ${my} L ${x} ${y}" stroke="white" stroke-width="${unit * .009}"/><path d="M ${mx} ${my} L ${x} ${y}" stroke="#172554" stroke-width="${unit * .004}"/><circle cx="${x}" cy="${y}" r="${unit * .006}" fill="#172554" stroke="white" stroke-width="${unit * .002}"/><circle cx="${mx}" cy="${my}" r="${radius}" fill="white" stroke="#172554" stroke-width="${unit * .003}"/><text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="${radius * 1.4}" font-weight="bold" fill="#172554">A</text><text x="${f.width / 2}" y="${f.height + f.width * .06}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${captionSize}" fill="#172554">${escape(f.orientation)}</text>${phase === 'answer' ? `<text x="${f.width / 2}" y="${f.height + f.width * .12}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${captionSize}" font-weight="bold" fill="#172554">${escape(`A: ${t.label}`)}</text>` : ''}</svg>`;
  } catch { return null; }
}
