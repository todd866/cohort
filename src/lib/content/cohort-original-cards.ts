/**
 * Strict loader for original, openly licensed Cohort cards.
 *
 * This lane is intentionally separate from md3's private school-year
 * rotations. Any malformed file empties the complete result, so a mirror
 * build cannot publish a partial or ambiguously attributed corpus.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { COHORT_DISCIPLINES, type CohortDiscipline } from './cohort-mirror';
import { cardReviewWithholds, publicCardContentHash, publicCardLeaks, type CardReviewLedger, type PublicCardReference, type PublicMirrorCard } from './cohort-mirror-cards';

export const DEFAULT_COHORT_ORIGINAL_ROOT = path.join(
  process.cwd(),
  'open-content',
  'modules',
  'original-cards',
);
export const ORIGINAL_CARD_NAMESPACE = 'cohort-original-card';

const DISCIPLINES = new Set<string>(COHORT_DISCIPLINES);
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'licence', 'attribution', 'discipline', 'items']);
const ITEM_KEYS = new Set(['originalId', 'front', 'back', 'context', 'complexity', 'importance', 'sources', 'review']);
const SOURCE_KEYS = new Set(['title', 'url']);
const REVIEW_KEYS = new Set(['status', 'contentHash', 'reviewer', 'reviewedAt']);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS = /^https:\/\/[^\s]+$/i;

interface OriginalSource { title: string; url: string }
interface OriginalReview {
  status: 'accepted';
  contentHash: string;
  reviewer: string;
  reviewedAt: string;
}
interface OriginalItem {
  originalId: string;
  front: string;
  back: string;
  context: string;
  complexity: number;
  importance: 1 | 2 | 3;
  sources: OriginalSource[];
  review: OriginalReview;
}
interface OriginalFile {
  schemaVersion: 1;
  licence: 'CC-BY-4.0';
  attribution: 'MD3 contributors';
  discipline: CohortDiscipline;
  items: OriginalItem[];
}

export interface LoadedOriginalCard {
  card: PublicMirrorCard;
  sourceFile: string;
  originalId: string;
}

export interface LoadedOriginalCards {
  files: string[];
  cards: LoadedOriginalCard[];
  errors: string[];
}

export interface OriginalCardManifest { schemaVersion: 1; ids: string[] }
const MANIFEST_KEYS = new Set(['schemaVersion', 'ids']);

export function parseOriginalCardManifest(raw: unknown, existingIds: ReadonlySet<string>): { manifest: OriginalCardManifest | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { manifest: null, errors: ['manifest: expected object'] };
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!MANIFEST_KEYS.has(key)) errors.push(`manifest: unexpected field ${key}`);
  if (value.schemaVersion !== 1 || !Array.isArray(value.ids) || value.ids.some((id) => typeof id !== 'string' || !id.trim())) {
    errors.push('manifest: expected schemaVersion 1 and non-empty string ids');
  }
  if (!Array.isArray(value.ids)) return { manifest: null, errors };
  const ids = value.ids as string[];
  if (new Set(ids).size !== ids.length) errors.push('manifest: duplicate ids');
  for (const id of ids) if (!existingIds.has(id)) errors.push(`manifest: id is absent from existing release: ${id}`);
  return errors.length ? { manifest: null, errors } : { manifest: { schemaVersion: 1, ids: [...ids].sort() }, errors: [] };
}

export function originalCardManifest(ids: readonly string[]): OriginalCardManifest {
  return { schemaVersion: 1, ids: [...new Set(ids)].sort() };
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function keys(value: object): string[] { return Object.keys(value); }
function rejectUnknown(value: object, allowed: ReadonlySet<string>, label: string, errors: string[]): void {
  for (const key of keys(value)) if (!allowed.has(key)) errors.push(`${label}: unexpected field ${key}`);
}
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function contentHash(item: Pick<OriginalItem, 'front' | 'back' | 'context' | 'complexity' | 'importance' | 'sources'>): string {
  return hash(JSON.stringify([item.front, item.back, item.context, item.complexity, item.importance, item.sources]));
}
function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !HTTPS.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch { return false; }
}
function sourceReference(source: OriginalSource): PublicCardReference {
  return { title: source.title, publisher: null, url: source.url };
}

function validateItem(raw: unknown, label: string, errors: string[]): raw is OriginalItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${label}: expected object`); return false; }
  rejectUnknown(raw, ITEM_KEYS, label, errors);
  const item = raw as Record<string, unknown>;
  if (typeof item.originalId !== 'string' || !SLUG.test(item.originalId)) errors.push(`${label}.originalId: expected a lowercase slug`);
  for (const field of ['front', 'back', 'context']) if (!nonEmpty(item[field])) errors.push(`${label}.${field}: expected non-empty text`);
  if (typeof item.front === 'string' && item.front.split('[___]').length !== 2) errors.push(`${label}.front: expected exactly one [___] blank`);
  if (!Number.isInteger(item.complexity) || (item.complexity as number) < 1 || (item.complexity as number) > 5) errors.push(`${label}.complexity: expected integer 1..5`);
  if (!Number.isInteger(item.importance) || ![1, 2, 3].includes(item.importance as number)) errors.push(`${label}.importance: expected 1, 2 or 3`);
  if (!Array.isArray(item.sources) || item.sources.length === 0) errors.push(`${label}.sources: expected at least one source`);
  else item.sources.forEach((source, index) => {
    const sourceLabel = `${label}.sources[${index}]`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) { errors.push(`${sourceLabel}: expected object`); return; }
    rejectUnknown(source, SOURCE_KEYS, sourceLabel, errors);
    const s = source as Record<string, unknown>;
    if (!nonEmpty(s.title)) errors.push(`${sourceLabel}.title: expected non-empty text`);
    if (!validHttpsUrl(s.url)) errors.push(`${sourceLabel}.url: expected an https URL without credentials`);
  });
  if (!item.review || typeof item.review !== 'object' || Array.isArray(item.review)) errors.push(`${label}.review: expected object`);
  else {
    rejectUnknown(item.review, REVIEW_KEYS, `${label}.review`, errors);
    const review = item.review as Record<string, unknown>;
    if (review.status !== 'accepted') errors.push(`${label}.review.status: expected accepted`);
    if (typeof review.contentHash !== 'string' || !SHA256.test(review.contentHash)) errors.push(`${label}.review.contentHash: expected SHA-256`);
    if (!nonEmpty(review.reviewer)) errors.push(`${label}.review.reviewer: expected non-empty text`);
    if (typeof review.reviewedAt !== 'string' || !validDate(review.reviewedAt)) errors.push(`${label}.review.reviewedAt: expected valid YYYY-MM-DD`);
    if (typeof review.contentHash === 'string' && SHA256.test(review.contentHash) && nonEmpty(item.front) && nonEmpty(item.back) && nonEmpty(item.context) && Number.isInteger(item.complexity) && Number.isInteger(item.importance)) {
      const expected = contentHash(item as unknown as Pick<OriginalItem, 'front' | 'back' | 'context' | 'complexity' | 'importance' | 'sources'>);
      if (review.contentHash !== expected) errors.push(`${label}.review.contentHash: does not match authored content`);
    }
  }
  return errors.length === 0;
}

function toCard(file: OriginalFile, item: OriginalItem): PublicMirrorCard {
  const origin = `md3:${hash(`${ORIGINAL_CARD_NAMESPACE}:${file.discipline}:${item.originalId}`).slice(0, 16)}`;
  return {
    id: `cohort:${file.discipline}:c-${hash(origin).slice(0, 12)}:v1`,
    origin,
    discipline: file.discipline,
    cardType: 'cloze',
    sourceComponent: 'KeyPoint',
    front: item.front,
    back: item.back,
    context: item.context,
    complexity: item.complexity,
    importance: item.importance,
    variantGroup: null,
    variantIndex: null,
    reference: sourceReference(item.sources[0]),
  };
}

function listFiles(root: string): string[] {
  if (!statSafe(root)) return [];
  const files: string[] = [];
  for (const discipline of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!discipline.isDirectory()) files.push(path.join(root, discipline.name));
    else for (const file of readdirSync(path.join(root, discipline.name), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (file.isFile() && file.name.endsWith('.json')) files.push(path.join(root, discipline.name, file.name));
      else files.push(path.join(root, discipline.name, file.name));
    }
  }
  return files;
}
function statSafe(file: string): boolean { try { statSync(file); return true; } catch { return false; } }

export function loadCohortOriginalCardsFromDisk(options: { root?: string } = {}): LoadedOriginalCards {
  const root = options.root ?? DEFAULT_COHORT_ORIGINAL_ROOT;
  const files = listFiles(root);
  const errors: string[] = [];
  const cards: LoadedOriginalCard[] = [];
  const seenOriginal = new Set<string>();
  const seenPublic = new Set<string>();
  if (!statSafe(root)) return { files, cards: [], errors: [`${root}: original-card source root is missing`] };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) errors.push(`${entry.name}: expected a discipline directory`);
    else if (!DISCIPLINES.has(entry.name)) errors.push(`${entry.name}: unknown discipline directory`);
  }

  for (const filePath of files) {
    const relativeFile = path.relative(root, filePath).split(path.sep).join('/');
    if (!filePath.endsWith('.json')) { errors.push(`${relativeFile}: unexpected non-JSON file`); continue; }
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(filePath, 'utf8')); } catch (error) { errors.push(`${relativeFile}: invalid JSON (${error instanceof Error ? error.message : String(error)})`); continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${relativeFile}: expected object`); continue; }
    const file = raw as Record<string, unknown>;
    rejectUnknown(file, TOP_LEVEL_KEYS, relativeFile, errors);
    if (file.schemaVersion !== 1 || file.licence !== 'CC-BY-4.0' || file.attribution !== 'MD3 contributors') errors.push(`${relativeFile}: expected schemaVersion 1, CC-BY-4.0 and MD3 contributors`);
    const directoryDiscipline = path.basename(path.dirname(filePath));
    if (typeof file.discipline !== 'string' || !DISCIPLINES.has(file.discipline) || file.discipline !== directoryDiscipline) errors.push(`${relativeFile}: discipline must be an allowed directory discipline`);
    if (!Array.isArray(file.items) || file.items.length === 0) { errors.push(`${relativeFile}: items must be a non-empty array`); continue; }
    const itemObjects: OriginalItem[] = [];
    file.items.forEach((item, index) => { if (validateItem(item, `${relativeFile}.items[${index}]`, errors)) itemObjects.push(item); });
    if (typeof file.discipline !== 'string' || !DISCIPLINES.has(file.discipline)) continue;
    for (const item of itemObjects) {
      const originalKey = `${file.discipline}:${item.originalId}`;
      if (seenOriginal.has(originalKey)) errors.push(`${relativeFile}: duplicate original card ${originalKey}`);
      seenOriginal.add(originalKey);
      const card = toCard(file as unknown as OriginalFile, item);
      if (seenPublic.has(card.id)) errors.push(`${relativeFile}: duplicate public card ${card.id}`);
      seenPublic.add(card.id);
      const leaks = publicCardLeaks(card);
      if (leaks.length) errors.push(`${relativeFile}: ${item.originalId}: leak: ${leaks.join('; ')}`);
      cards.push({ card, sourceFile: `open-content/modules/original-cards/${relativeFile}`, originalId: item.originalId });
    }
  }
  return { files, cards: errors.length === 0 ? cards : [], errors };
}

/** Merge an original lane into an existing release by stable public id.
 * Originals replace an older copy with the same id; the operation is idempotent.
 */
export function mergeOriginalCards(
  existing: readonly PublicMirrorCard[],
  originals: readonly PublicMirrorCard[],
): PublicMirrorCard[] {
  const byId = new Map<string, PublicMirrorCard>();
  for (const card of existing) {
    if (byId.has(card.id)) throw new Error(`duplicate existing public card ${card.id}`);
    byId.set(card.id, card);
  }
  for (const card of originals) byId.set(card.id, card);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Remove the prior original lane before adding the current source set. */
export function publishedOriginalCards(cards: readonly PublicMirrorCard[], reviews: CardReviewLedger): PublicMirrorCard[] {
  return cards.filter((card) => !cardReviewWithholds(card, reviews));
}

export function reconcileOriginalCards(
  existing: readonly PublicMirrorCard[],
  priorOriginalIds: readonly string[],
  originals: readonly PublicMirrorCard[],
): PublicMirrorCard[] {
  const existingIds = new Set(existing.map((card) => card.id));
  for (const id of priorOriginalIds) if (!existingIds.has(id)) throw new Error(`prior original id is absent from existing release: ${id}`);
  const prior = new Set(priorOriginalIds);
  return mergeOriginalCards(existing.filter((card) => !prior.has(card.id)), originals);
}

export const originalCardContentHash = contentHash;
export const originalCardPublicContentHash = publicCardContentHash;
