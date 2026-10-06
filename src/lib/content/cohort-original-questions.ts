import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { COHORT_DISCIPLINES, type CohortDiscipline, type MirrorOption, type PublicMirrorQuestion } from './cohort-mirror';

export const DEFAULT_COHORT_ORIGINAL_QUESTION_ROOT = path.join(process.cwd(), 'open-content', 'modules', 'original-question-sources');
export const ORIGINAL_QUESTION_NAMESPACE = 'cohort-original-question';

const DISCIPLINES = new Set<string>(COHORT_DISCIPLINES);
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'status', 'licence', 'attribution', 'discipline', 'evidenceNote', 'sourceRegister', 'items']);
const ITEM_KEYS = new Set(['originalId', 'region', 'stem', 'options', 'context', 'topics', 'difficulty', 'questionType', 'sources', 'reference', 'review']);
const OPTION_KEYS = new Set(['label', 'text', 'isCorrect', 'explanation']);
const SOURCE_KEYS = new Set(['title', 'url']);
const REVIEW_KEYS = new Set(['status', 'contentHash', 'reviewer', 'reviewedAt']);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS = /^https:\/\/[^\s]+$/i;

export interface OriginalQuestionSource { title: string; url: string }
export interface OriginalQuestionOption { label: string; text: string; isCorrect: boolean; explanation: string }
export interface OriginalQuestionReview { status: 'accepted'; contentHash: string; reviewer: string; reviewedAt: string }
export interface OriginalQuestionItem {
  originalId: string;
  stem: string;
  options: OriginalQuestionOption[];
  context: string | null;
  topics: string[];
  difficulty: string | null;
  questionType: string | null;
  sources: OriginalQuestionSource[];
  review: OriginalQuestionReview;
}
interface OriginalQuestionFile { schemaVersion: 1; licence: 'CC-BY-4.0'; attribution: 'MD3 contributors'; discipline: CohortDiscipline; items: OriginalQuestionItem[] }

export interface LoadedOriginalQuestion { question: PublicMirrorQuestion; sourceFile: string; originalId: string }
export interface LoadedOriginalQuestions { files: string[]; questions: LoadedOriginalQuestion[]; errors: string[] }
export interface OriginalQuestionManifest { schemaVersion: 1; originalIds: string[] }
const MANIFEST_KEYS = new Set(['schemaVersion', 'originalIds']);

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function rejectUnknown(value: object, allowed: ReadonlySet<string>, label: string, errors: string[]): void { for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}: unexpected field ${key}`); }
function validDate(value: string): boolean { if (!ISO_DATE.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value; }
function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !HTTPS.test(value)) return false;
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password; } catch { return false; }
}

/** Hash of the complete reviewed question, including its cited source. */
export function originalQuestionContentHash(item: Pick<OriginalQuestionItem, 'stem' | 'options' | 'context' | 'topics' | 'difficulty' | 'questionType' | 'sources'>): string {
  return hash(JSON.stringify({ stem: item.stem, options: item.options, context: item.context, topics: item.topics, difficulty: item.difficulty, questionType: item.questionType, sources: item.sources }));
}

function validateItem(raw: unknown, label: string, errors: string[]): raw is OriginalQuestionItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${label}: expected object`); return false; }
  rejectUnknown(raw, ITEM_KEYS, label, errors);
  const item = raw as Record<string, unknown>;
  if (typeof item.originalId !== 'string' || !SLUG.test(item.originalId)) errors.push(`${label}.originalId: expected a lowercase slug`);
  if (!nonEmpty(item.stem)) errors.push(`${label}.stem: expected non-empty text`);
  if (!Array.isArray(item.options) || item.options.length < 2) errors.push(`${label}.options: expected at least two options`);
  const options = Array.isArray(item.options) ? item.options : [];
  const labels = new Set<string>();
  let correct = 0;
  options.forEach((rawOption, index) => {
    const optionLabel = `${label}.options[${index}]`;
    if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) { errors.push(`${optionLabel}: expected object`); return; }
    rejectUnknown(rawOption, OPTION_KEYS, optionLabel, errors);
    const option = rawOption as Record<string, unknown>;
    if (!nonEmpty(option.label) || labels.has(option.label)) errors.push(`${optionLabel}.label: expected a unique non-empty label`); else labels.add(option.label);
    if (!nonEmpty(option.text)) errors.push(`${optionLabel}.text: expected non-empty text`);
    if (typeof option.isCorrect !== 'boolean') errors.push(`${optionLabel}.isCorrect: expected boolean`); else if (option.isCorrect) correct++;
    if (!nonEmpty(option.explanation)) errors.push(`${optionLabel}.explanation: expected non-empty text`);
  });
  if (correct !== 1) errors.push(`${label}.options: expected exactly one correct option`);
  if (item.context !== null && !nonEmpty(item.context)) errors.push(`${label}.context: expected non-empty text or null`);
  if (!Array.isArray(item.topics) || item.topics.some((topic) => !nonEmpty(topic))) errors.push(`${label}.topics: expected an array of non-empty strings`);
  for (const field of ['difficulty', 'questionType']) if (item[field] !== null && !nonEmpty(item[field])) errors.push(`${label}.${field}: expected non-empty text or null`);
  const rawSources = Array.isArray(item.sources) ? item.sources : (item.reference ? [item.reference] : []);
  if (rawSources.length === 0) errors.push(`${label}.sources: expected at least one source or reference`);
  rawSources.forEach((rawSource, index) => {
    const sourceLabel = `${label}.sources[${index}]`;
    if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) { errors.push(`${sourceLabel}: expected object`); return; }
    rejectUnknown(rawSource, SOURCE_KEYS, sourceLabel, errors);
    const source = rawSource as Record<string, unknown>;
    if (!nonEmpty(source.title)) errors.push(`${sourceLabel}.title: expected non-empty text`);
    if (!validHttpsUrl(source.url)) errors.push(`${sourceLabel}.url: expected an https URL without credentials`);
  });
  if (!item.review || typeof item.review !== 'object' || Array.isArray(item.review)) errors.push(`${label}.review: expected object`);
  else {
    rejectUnknown(item.review, REVIEW_KEYS, `${label}.review`, errors);
    const review = item.review as Record<string, unknown>;
    if (review.status !== 'accepted') errors.push(`${label}.review.status: expected accepted`);
    if (typeof review.contentHash !== 'string' || !SHA256.test(review.contentHash)) errors.push(`${label}.review.contentHash: expected SHA-256`);
    if (!nonEmpty(review.reviewer)) errors.push(`${label}.review.reviewer: expected non-empty text`);
    if (typeof review.reviewedAt !== 'string' || !validDate(review.reviewedAt)) errors.push(`${label}.review.reviewedAt: expected valid YYYY-MM-DD`);
    if (typeof review.contentHash === 'string' && SHA256.test(review.contentHash) && nonEmpty(item.stem) && Array.isArray(item.options) && Array.isArray(item.topics) && (Array.isArray(item.sources) || Boolean(item.reference))) {
      const authored = { ...item, sources: Array.isArray(item.sources) ? item.sources : [item.reference] };
      const expected = originalQuestionContentHash(authored as unknown as Pick<OriginalQuestionItem, 'stem' | 'options' | 'context' | 'topics' | 'difficulty' | 'questionType' | 'sources'>);
      if (review.contentHash !== expected) errors.push(`${label}.review.contentHash: does not match authored content`);
    }
  }
  return errors.length === 0;
}

function normaliseItem(raw: OriginalQuestionItem & { reference?: OriginalQuestionSource }): OriginalQuestionItem {
  return { ...raw, context: raw.context ?? null, topics: raw.topics ?? [], difficulty: raw.difficulty ?? null, questionType: raw.questionType ?? null, sources: raw.sources?.length ? raw.sources : [raw.reference!] };
}

export function originalQuestionOrigin(discipline: CohortDiscipline, originalId: string): string { return `md3:${hash(`${ORIGINAL_QUESTION_NAMESPACE}:${discipline}:${originalId}`).slice(0, 16)}`; }
function toQuestion(file: OriginalQuestionFile, item: OriginalQuestionItem): PublicMirrorQuestion {
  const origin = originalQuestionOrigin(file.discipline, item.originalId);
  return {
    id: `cohort:${file.discipline}:q-${hash(origin).slice(0, 12)}:v1`, origin, discipline: file.discipline,
    stem: item.stem, options: item.options.map((option): MirrorOption => ({ ...option })), context: item.context,
    topics: [...item.topics], difficulty: item.difficulty, questionType: item.questionType,
    reference: { title: item.sources[0].title, publisher: null, url: item.sources[0].url }, licence: 'CC-BY-4.0', attribution: 'MD3 contributors',
  };
}
function statSafe(file: string): boolean { try { statSync(file); return true; } catch { return false; } }
function listFiles(root: string): string[] {
  if (!statSafe(root)) return [];
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && entry.name.endsWith('.json') ? [absolute] : [absolute];
  });
  return walk(root);
}

export function loadCohortOriginalQuestionsFromDisk(options: { root?: string } = {}): LoadedOriginalQuestions {
  const root = options.root ?? DEFAULT_COHORT_ORIGINAL_QUESTION_ROOT;
  const files = listFiles(root);
  const errors: string[] = [];
  const questions: LoadedOriginalQuestion[] = [];
  const seenOriginal = new Set<string>();
  const seenPublic = new Set<string>();
  if (!statSafe(root)) return { files, questions: [], errors: [`${root}: original-question source root is missing`] };
  for (const filePath of files) {
    const relativeFile = path.relative(root, filePath).split(path.sep).join('/');
    if (!filePath.endsWith('.json')) { errors.push(`${relativeFile}: unexpected non-JSON file`); continue; }
    let raw: unknown; try { raw = JSON.parse(readFileSync(filePath, 'utf8')); } catch (error) { errors.push(`${relativeFile}: invalid JSON (${error instanceof Error ? error.message : String(error)})`); continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${relativeFile}: expected object`); continue; }
    const file = raw as Record<string, unknown>; rejectUnknown(file, TOP_LEVEL_KEYS, relativeFile, errors);
    if (file.schemaVersion !== 1 || file.licence !== 'CC-BY-4.0' || file.attribution !== 'MD3 contributors') errors.push(`${relativeFile}: expected schemaVersion 1, CC-BY-4.0 and MD3 contributors`);
    if (typeof file.discipline !== 'string' || !DISCIPLINES.has(file.discipline)) { errors.push(`${relativeFile}: unknown discipline`); continue; }
    if (!Array.isArray(file.items) || file.items.length === 0) { errors.push(`${relativeFile}: items must be a non-empty array`); continue; }
    const validItems: OriginalQuestionItem[] = [];
    file.items.forEach((item, index) => { if (validateItem(item, `${relativeFile}.items[${index}]`, errors)) validItems.push(normaliseItem(item as OriginalQuestionItem & { reference?: OriginalQuestionSource })); });
    for (const item of validItems) {
      if (seenOriginal.has(item.originalId)) errors.push(`${relativeFile}: duplicate original question ${item.originalId}`);
      seenOriginal.add(item.originalId);
      const question = toQuestion(file as unknown as OriginalQuestionFile, item);
      if (seenPublic.has(question.id)) errors.push(`${relativeFile}: duplicate public question ${question.id}`);
      seenPublic.add(question.id);
      questions.push({ question, sourceFile: `open-content/modules/original-question-sources/${relativeFile}`, originalId: item.originalId });
    }
  }
  return { files, questions: errors.length === 0 ? questions : [], errors };
}

export function originalQuestionManifest(originalIds: readonly string[]): OriginalQuestionManifest { return { schemaVersion: 1, originalIds: [...new Set(originalIds)].sort() }; }
export function parseOriginalQuestionManifest(raw: unknown, existingOriginalIds: ReadonlySet<string>): { manifest: OriginalQuestionManifest | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { manifest: null, errors: ['manifest: expected object'] };
  const value = raw as Record<string, unknown>; rejectUnknown(value, MANIFEST_KEYS, 'manifest', errors);
  if (value.schemaVersion !== 1 || !Array.isArray(value.originalIds) || value.originalIds.some((id) => typeof id !== 'string' || !SLUG.test(id))) errors.push('manifest: expected schemaVersion 1 and lowercase slug originalIds');
  if (!Array.isArray(value.originalIds)) return { manifest: null, errors };
  const ids = value.originalIds as string[];
  if (new Set(ids).size !== ids.length) errors.push('manifest: duplicate originalIds');
  for (const id of ids) if (!existingOriginalIds.has(id)) errors.push(`manifest: originalId is absent from existing release: ${id}`);
  return errors.length ? { manifest: null, errors } : { manifest: originalQuestionManifest(ids), errors: [] };
}

export function mergeOriginalQuestions(existing: readonly PublicMirrorQuestion[], originals: readonly PublicMirrorQuestion[]): PublicMirrorQuestion[] {
  const byId = new Map<string, PublicMirrorQuestion>();
  for (const question of existing) { if (byId.has(question.id)) throw new Error(`duplicate existing public question ${question.id}`); byId.set(question.id, question); }
  for (const question of originals) {
    if (byId.has(question.id)) throw new Error(`duplicate original public question ${question.id}`);
    byId.set(question.id, question);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Removes only the prior original lane, identified by its stable original IDs. */
export function reconcileOriginalQuestions(existing: readonly PublicMirrorQuestion[], priorOriginalIds: readonly string[], originals: readonly LoadedOriginalQuestion[]): PublicMirrorQuestion[] {
  const priorOrigins = new Set<string>();
  // The manifest deliberately stores authored IDs rather than public IDs. Derive
  // every possible lane origin, so a withdrawn item is still removable while a
  // private/released row with another origin is left untouched.
  for (const id of priorOriginalIds) for (const discipline of COHORT_DISCIPLINES) priorOrigins.add(originalQuestionOrigin(discipline, id));
  return mergeOriginalQuestions(existing.filter((question) => !priorOrigins.has(question.origin)), originals.map((loaded) => loaded.question));
}
