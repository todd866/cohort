import manifestJson from '../../../open-content/medical-figures/manifest.json';
import type { DiagramSidecar } from '../images/types';

export const ORIGINAL_FIGURE_PREFIX = '/figures/originals/';
export const ORIGINAL_FIGURE_ROOT = 'open-content/medical-figures';

export interface OriginalFigure {
  id: string;
  title: string;
  file: string;
  sha256: string;
  width: number;
  height: number;
  generatedAt?: string;
  caption: string;
  alt: string;
  review: {
    status: 'accepted'; method: 'agent-visual-and-source-review'; notes: string;
    structure: { kind: 'conceptual' | 'spatial-anatomy'; reviewedFigureSha256?: string; annotationFile?: string; status: 'verified'; specificationFiles: string[]; notes: string };
  };
  generation: {
    tool: string;
    model: string | null;
    promptFiles: string[];
    referenceAssetIds: string[];
    /** Provenance of our own withdrawn style references; their pixels are not distributed. */
    archivedReferenceAssets?: Array<{ id: string; sha256: string; role: 'style-only'; reason: string }>;
    externalReferenceImages: [];
  };
  clinicalSources: Array<{ title: string; url: string }>;
  teaching: { question: string; answer: string; imageRole: 'prompt' | 'after-reveal' };
}

export interface OriginalFigureManifest {
  schemaVersion: 1;
  license: 'MIT';
  attribution: string;
  createdAt?: string;
  figures: OriginalFigure[];
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
const PROMPT = /^prompts\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:json|md|txt)$/;
const SCAFFOLD = /^scaffolds\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Original figures: ${message}`);
}

/** Server/build admission contract. Anatomy additionally requires review bound to the delivered bytes. */
export function parseOriginalFigureManifest(value: unknown): OriginalFigureManifest {
  requireValue(record(value), 'manifest must be an object');
  requireValue(value.schemaVersion === 1 && value.license === 'MIT', 'schemaVersion 1 and MIT required');
  requireValue(text(value.attribution), 'attribution required');
  requireValue(value.createdAt === undefined || date(value.createdAt), 'invalid createdAt');
  requireValue(Array.isArray(value.figures) && value.figures.length > 0, 'figures required');
  const ids = new Set<string>();
  for (const figure of value.figures) {
    requireValue(record(figure) && text(figure.id) && ID.test(figure.id), 'unsafe figure id');
    const id = figure.id;
    requireValue(!ids.has(id), `duplicate id ${id}`);
    ids.add(id);
    requireValue(figure.file === `images/${id}.png`, `${id}: exact PNG source path required`);
    requireValue(text(figure.sha256) && HASH.test(figure.sha256), `${id}: invalid sha256`);
    requireValue(Number.isSafeInteger(figure.width) && Number(figure.width) > 0
      && Number.isSafeInteger(figure.height) && Number(figure.height) > 0, `${id}: invalid dimensions`);
    requireValue(text(figure.title) && text(figure.caption) && text(figure.alt), `${id}: teaching labels required`);
    requireValue(figure.generatedAt === undefined || date(figure.generatedAt), `${id}: invalid generatedAt`);
    requireValue(date(figure.generatedAt ?? value.createdAt), `${id}: generatedAt or createdAt required`);
    requireValue(record(figure.review) && figure.review.status === 'accepted'
      && figure.review.method === 'agent-visual-and-source-review' && text(figure.review.notes), `${id}: accepted agent QA required`);
    const structure = figure.review.structure;
    requireValue(record(structure) && (structure.kind === 'conceptual' || structure.kind === 'spatial-anatomy') && structure.status === 'verified'
      && text(structure.notes) && Array.isArray(structure.specificationFiles) && structure.specificationFiles.length > 0
      && structure.specificationFiles.every((file) => typeof file === 'string' && SCAFFOLD.test(file)),
    `${id}: verified supported scaffold required`);
    if (structure.kind === 'spatial-anatomy') {
      requireValue(structure.annotationFile === `annotations/${id}.svg`, `${id}: exact anatomy annotationFile required`);
      requireValue(structure.reviewedFigureSha256 === figure.sha256, `${id}: anatomy review must match figure sha256`);
    }
    const generation = figure.generation;
    requireValue(record(generation) && text(generation.tool), `${id}: generation provenance required`);
    requireValue(Array.isArray(generation.externalReferenceImages)
      && generation.externalReferenceImages.length === 0, `${id}: external reference images forbidden`);
    requireValue(Array.isArray(generation.referenceAssetIds)
      && generation.referenceAssetIds.every((ref) => text(ref) && ID.test(ref)), `${id}: invalid original references`);
    requireValue(generation.archivedReferenceAssets === undefined || (Array.isArray(generation.archivedReferenceAssets)
      && generation.archivedReferenceAssets.every((ref) => record(ref) && text(ref.id) && ID.test(ref.id)
        && text(ref.sha256) && HASH.test(ref.sha256) && ref.role === 'style-only' && text(ref.reason))),
    `${id}: invalid archived style reference provenance`);
    requireValue(Array.isArray(generation.promptFiles) && generation.promptFiles.length > 0
      && generation.promptFiles.every((file) => typeof file === 'string' && PROMPT.test(file)), `${id}: unsafe prompt path`);
    requireValue(Array.isArray(figure.clinicalSources) && figure.clinicalSources.length > 0
      && figure.clinicalSources.every((source) => record(source) && text(source.title)
        && typeof source.url === 'string' && /^https:\/\/[^\s/]+\//.test(source.url)), `${id}: clinical references required`);
    requireValue(record(figure.teaching) && text(figure.teaching.question) && text(figure.teaching.answer)
      && ['prompt', 'after-reveal'].includes(String(figure.teaching.imageRole)), `${id}: teaching role required`);
    requireValue(structure.kind !== 'spatial-anatomy' || figure.teaching.imageRole === 'after-reveal',
      `${id}: anatomy requires after-reveal placement`);
  }
  for (const figure of value.figures) {
    for (const ref of figure.generation.referenceAssetIds) {
      requireValue(ids.has(ref), `${figure.id}: unreviewed reference ${ref}`);
    }
  }
  return value as unknown as OriginalFigureManifest;
}

export function originalFigureSidecar(
  figure: OriginalFigure,
  manifest: OriginalFigureManifest,
): DiagramSidecar {
  return {
    class: 'diagram',
    usageTier: 'public-attribution',
    accessTier: 'public',
    showWhen: figure.teaching.imageRole === 'prompt' ? 'always' : 'after-reveal',
    source: 'MD3 original medical diagrams',
    sourcePage: '',
    directImageUrl: `${ORIGINAL_FIGURE_PREFIX}${figure.id}.png`,
    license: 'MIT',
    licenseUrl: 'https://opensource.org/license/mit',
    attributionText: `${manifest.attribution} — original educational diagram — MIT`,
    noOptimize: true,
    hash: `sha256-${figure.sha256}`,
    dimensions: { w: figure.width, h: figure.height },
    addedBy: 'install-original-diagrams',
    addedAt: figure.generatedAt ?? manifest.createdAt!,
    clinicalReviewStatus: 'pending',
    containsIdentifiablePatient: false,
    topic: figure.title,
    caption: figure.caption,
    altPolicy: 'descriptive',
  };
}

// A malformed collection fails closed without taking unrelated figures down.
function acceptedManifest(): OriginalFigureManifest | null {
  try { return parseOriginalFigureManifest(manifestJson); } catch { return null; }
}
export const originalFigureManifest = acceptedManifest();
const byPath = new Map(originalFigureManifest?.figures.map((figure) => [
  `${ORIGINAL_FIGURE_PREFIX}${figure.id}.png`, figure,
]) ?? []);

export function getOriginalFigure(path: string | null | undefined): OriginalFigure | undefined {
  return typeof path === 'string' ? byPath.get(path) : undefined;
}
