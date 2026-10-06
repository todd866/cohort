import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../../../open-content/anatomy-scaffolds/source-figures/manifest.json';
import { isAnatomySourceFigureId } from '@/lib/cohort/anatomy-figure-catalogue';

export interface AnatomySourceFigure {
  id: string;
  file: string;
  sha256: string;
  mime: 'image/jpeg' | 'image/png';
  licence: 'CC-BY-3.0' | 'CC-BY-4.0' | 'CC-BY-SA-3.0' | 'CC-BY-SA-4.0' | 'Public-Domain';
  sourceUrl: string;
  attribution: string;
  review: { status: 'accepted'; reviewer: string; claims: string[] };
}
const licences = new Set(['CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0', 'Public-Domain']);
/** Fail closed on unknown ids, licences, review state, paths or changed bytes. */
export function readAnatomySourceFigure(id: unknown, options: {
  entries?: readonly AnatomySourceFigure[];
  read?: (filename: string) => Uint8Array;
} = {}): { bytes: Uint8Array; figure: AnatomySourceFigure } | null {
  if (!isAnatomySourceFigureId(id)) return null;
  const entries = options.entries ?? manifest.figures as AnatomySourceFigure[];
  const matches = entries.filter(entry => entry.id === id);
  if (matches.length !== 1) return null;
  const figure = matches[0];
  if (!/^[a-z0-9-]+\.(jpg|png)$/.test(figure.file)
    || !/^[a-f0-9]{64}$/.test(figure.sha256)
    || !licences.has(figure.licence)
    || figure.review?.status !== 'accepted' || !figure.review.reviewer?.trim()
    || !figure.review.claims?.length || !figure.attribution?.trim()
    || !figure.sourceUrl?.startsWith('https://')
    || (figure.mime !== 'image/jpeg' && figure.mime !== 'image/png')) return null;
  try {
    const bytes = (options.read ?? (file => readFileSync(join(process.cwd(), 'open-content/anatomy-scaffolds/source-figures', file))))(figure.file);
    if (createHash('sha256').update(bytes).digest('hex') !== figure.sha256) return null;
    return { bytes, figure };
  } catch { return null; }
}
