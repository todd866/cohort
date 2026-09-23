/**
 * Pure rules for mirroring md3's modules into Cohort.
 * See docs/designs/2026-09-23-cohort-mirror.md.
 *
 * Two filters, and only one removes content. RIGHTS decides whether an item may
 * ship at all (with ./rights-provenance for cards). USyd decides only how it is
 * labelled: USyd-derived medicine ships under a DISCIPLINE, never under a
 * rotation, week, block or assessment. USyd's own copyright (KAT and practice
 * papers, lecture wording) is a rights exclusion, not a USyd one.
 *
 * Nothing here returns `authored`. Like the card classifier, these rules only
 * rule things OUT; promotion is a separate, evidenced decision.
 */
import { createHash } from 'node:crypto';

import type { ProvenanceResult } from './rights-provenance';
import { classifySourceTier } from './source-tier';

/** Cohort's modules: the 30-slug tree under content/modules, plus three md3 has as modules and the tree lacks. */
export const COHORT_DISCIPLINES = [
  'aged', 'anaes', 'anatomy', 'cardio', 'clinical-skills', 'derm', 'ebm', 'em', 'endo', 'ent',
  'gi', 'gp', 'gynae', 'haem', 'icu', 'id', 'immuno', 'msk', 'neuro', 'obs', 'onc', 'ophth',
  'paeds', 'paramedicine', 'pathology', 'pharm', 'physiology', 'psych', 'renal', 'resp',
  'surgery', 'neurosurgery', 'radiology',
] as const;
export type CohortDiscipline = (typeof COHORT_DISCIPLINES)[number];

const DISCIPLINE_SET: ReadonlySet<string> = new Set(COHORT_DISCIPLINES);

/** md3 moduleNodes tokens that name a discipline under another spelling. */
const MODULE_TOKEN_DISCIPLINE: Readonly<Record<string, CohortDiscipline>> = Object.freeze({
  paediatrics: 'paeds', neonatology: 'paeds', neonatal: 'paeds', 'child-protection': 'paeds',
  dermatology: 'derm',
  gastroenterology: 'gi',
  'infectious-diseases': 'id', infectiousdiseases: 'id',
  emergency: 'em', trauma: 'em', toxicology: 'em',
  neurology: 'neuro',
  endocrinology: 'endo',
  orthopaedics: 'msk', rheumatology: 'msk',
  'critical-care': 'icu',
  surgery: 'surgery', gsse: 'surgery', 'paediatric-surgery': 'surgery',
  neurosurg: 'neurosurgery',
  respiratory: 'resp',
  ophthalmology: 'ophth',
  haematology: 'haem',
  oncology: 'onc',
  cardiology: 'cardio',
  immunology: 'immuno',
  obstetrics: 'obs',
  gynaecology: 'gynae',
  psychiatry: 'psych',
  pharmacology: 'pharm',
  generalpractice: 'gp', 'general-practice': 'gp',
  nephrology: 'renal',
  radiology: 'radiology',
  geriatrics: 'aged',
  anaesthetics: 'anaes',
});

/** Rotation and deck codes: never a discipline, and never shown publicly. */
const ROTATION_CODES: ReadonlySet<string> = new Set([
  'cah', 'paam', 'pwh', 'cc', 'year3-common', 'toc', 'mnd', 'usmle', 'mcat', 'gamsat', 'wiki',
]);

/** Where a rotation's items land when their own tags name no discipline. */
const ROTATION_DEFAULT_DISCIPLINE: Readonly<Record<string, CohortDiscipline>> = Object.freeze({
  cah: 'paeds',
  pwh: 'obs',
  paam: 'psych',
  'critical-care': 'icu',
  neurosurg: 'neurosurgery',
  mnd: 'neuro',
  toc: 'clinical-skills',
  'year3-common': 'gp',
  ortho: 'msk',
  geriatrics: 'aged',
  neurology: 'neuro',
  urology: 'surgery',
  radiology: 'radiology',
});

export interface DisciplineAssignment {
  discipline: CohortDiscipline | null;
  via: 'modules' | 'rotation' | 'none';
}

/**
 * The Cohort module an item belongs to: its own module tags first, then its
 * rotation's default. Returns null rather than guessing.
 */
export function assignDiscipline(input: { modulesAttr?: string | null; rotation?: string | null }): DisciplineAssignment {
  for (const raw of (input.modulesAttr ?? '').split(',')) {
    const token = raw.trim().toLowerCase();
    if (!token || ROTATION_CODES.has(token)) continue;
    const discipline = DISCIPLINE_SET.has(token) ? (token as CohortDiscipline) : MODULE_TOKEN_DISCIPLINE[token];
    if (discipline) return { discipline, via: 'modules' };
  }
  const fallback = ROTATION_DEFAULT_DISCIPLINE[(input.rotation ?? '').toLowerCase()];
  return fallback ? { discipline: fallback, via: 'rotation' } : { discipline: null, via: 'none' };
}

/** Question banks that are imports or USyd assessment material in their entirety. */
const IMPORT_QUESTION_DIRS: ReadonlySet<string> = new Set([
  'anking', 'malleus', 'surgical-sciences', 'kat1', 'kat2', 'kat3', 'year2', '_private-usmle-step1',
]);

/** File-name families that mark an extraction, an import, or an assessment paper. */
const IMPORT_QUESTION_FILE = /textbook|extracted|kat-import|practice-exam|practice-kat|anki|stuanki|malleus|medbank|zanki|queso|pedi-boards/i;

/** An item `source` naming a commercial bank or USyd course material. */
const IMPORT_QUESTION_SOURCE = /medbank|\bKAT\d?\b|\blecture|\bBlock \d/i;

/**
 * Rights provenance for a bank question, from FILE-level evidence. Most bank
 * questions carry no provenance field at all (measured 2026-09-23: 9,700 of the
 * rotation banks), so the file family and directory are the evidence.
 */
export function classifyQuestionFileProvenance(input: {
  path: string;
  rotation?: string | null;
  source?: string | null;
}): ProvenanceResult {
  const parts = input.path.split('/');
  const bankDir = parts[0] === 'question-bank' ? parts[1] : parts[0];
  if (bankDir && IMPORT_QUESTION_DIRS.has(bankDir)) {
    return { provenance: 'import', reason: `question bank "${bankDir}" is imported or assessment material` };
  }
  const basename = parts[parts.length - 1] ?? '';
  const fileMarker = IMPORT_QUESTION_FILE.exec(basename);
  if (fileMarker) {
    return { provenance: 'import', reason: `question file family "${fileMarker[0].toLowerCase()}"` };
  }
  const sourceMarker = IMPORT_QUESTION_SOURCE.exec(input.source ?? '');
  if (sourceMarker) {
    return { provenance: 'import', reason: `question source names "${sourceMarker[0].trim()}"` };
  }
  return { provenance: 'unreviewed', reason: 'no import marker; awaiting evidenced promotion' };
}

/**
 * USyd course-structure markers in an item's text. Each one withholds the item
 * with a named reason; nothing here rewrites text. Clinical uses of "week" and
 * "block" (gestation, heart block) must not fire, and "CAH" alone usually means
 * congenital adrenal hyperplasia, so a rotation code counts only beside a
 * course word.
 */
const USYD_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['kat', /\bKAT\s?\d?\b/],
  ['wba', /\bWBAs?\b/],
  ['canvas', /\bCanvas\b/],
  ['usyd', /\bUSyd\b|University of Sydney|Sydney Medical School/i],
  ['block', /\bBlock\s+\d/],
  ['rotation-code', /\b(?:CAH|PAAM|PWH)\s+(?:week|rotation|block|term|tutor|tutorial|lecture|teaching|exam)\b/i],
];

export function usydCourseMarkers(text: string): string[] {
  return USYD_MARKERS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Increment 2: questions. Owner, 2026-09-23: a QUESTION publishes only with a
// guideline-tier, supporting grounded citation; cards follow later on
// rights-clean + factual-audit-clean.
// ---------------------------------------------------------------------------

const words = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * How many runs of `runLength` consecutive words `text` shares with `source`.
 * Any shared run of 8 words is copied expression, not a restated fact: the
 * rights rule is that the wording must be ours even when the claim is theirs.
 */
export function sharedWordRuns(text: string, source: string, runLength = 8): number {
  const sourceRuns = new Set<string>();
  const s = words(source);
  for (let i = 0; i + runLength <= s.length; i++) sourceRuns.add(s.slice(i, i + runLength).join(' '));
  const t = words(text);
  let shared = 0;
  for (let i = 0; i + runLength <= t.length; i++) if (sourceRuns.has(t.slice(i, i + runLength).join(' '))) shared++;
  return shared;
}

export interface MirrorOption { label: string; text: string; isCorrect?: boolean; explanation?: string }
export interface MirrorQuestionInput {
  id: string;
  stem: string;
  options: MirrorOption[];
  context?: string | null;
  topics?: string[] | null;
  moduleNodes?: string[] | null;
  difficulty?: string | null;
  questionType?: string | null;
  source?: string | null;
  imageUrl?: string | null;
}
/** A source resolved to its publisher's document and an HTTP-verified URL. */
export interface VerifiedReference { title: string; publisher: string | null; url: string; verifiedAt: string }
export type ReferenceIndex = Readonly<Record<string, VerifiedReference>>;

export interface MirrorCitation {
  sourceSlug?: string | null;
  paperTitle?: string | null;
  url?: string | null;
  doi?: string | null;
  relationship?: string | null;
  quote?: string | null;
}

const questionText = (q: MirrorQuestionInput): string =>
  [q.stem, q.context ?? '', ...q.options.flatMap((o) => [o.text, o.explanation ?? ''])].join('\n');

/** Whether one bank question may join Cohort, and every reason it may not. */
export function decideMirrorQuestion(input: {
  question: MirrorQuestionInput;
  path: string;
  citation: MirrorCitation | null;
  /** When given, a question also needs its source resolved to a verified reference. */
  references?: ReferenceIndex;
}): { publish: boolean; discipline: CohortDiscipline | null; reasons: string[] } {
  const { question, path, citation, references } = input;
  const reasons: string[] = [];
  const rotation = path.split('/')[1] ?? '';

  const rights = classifyQuestionFileProvenance({ path, rotation, source: question.source ?? null });
  if (rights.provenance === 'import') reasons.push(`import: ${rights.reason}`);

  const grounded = citation?.relationship === 'supports'
    && classifySourceTier({ url: citation.url, title: citation.paperTitle, sourceSlug: citation.sourceSlug, doi: citation.doi }).tier === 'guideline';
  if (!grounded) reasons.push('no guideline-tier supporting citation');
  if (grounded && references && !references[citation?.sourceSlug ?? '']) {
    reasons.push(`no verified reference for ${citation?.sourceSlug ?? 'unknown source'}`);
  }

  const nodes = (question.moduleNodes ?? []).map((n) => n.split('/').pop() ?? '').join(',');
  const { discipline } = assignDiscipline({ modulesAttr: `${nodes},${(question.topics ?? []).join(',')}`, rotation });
  if (!discipline) reasons.push('no discipline');

  if (question.imageUrl) reasons.push('carries an image');

  const markers = usydCourseMarkers(questionText(question));
  if (markers.length) reasons.push(`USyd marker: ${markers.join('+')}`);

  if (citation?.quote && sharedWordRuns(questionText(question), citation.quote) > 0) {
    reasons.push('verbatim 8-word run from the cited passage');
  }

  return { publish: reasons.length === 0, discipline, reasons };
}

export interface PublicMirrorQuestion {
  id: string;
  origin: string;
  discipline: CohortDiscipline;
  stem: string;
  options: MirrorOption[];
  context: string | null;
  topics: string[];
  difficulty: string | null;
  questionType: string | null;
  reference: { title: string | null; url: string | null; publisher?: string | null };
  licence: 'CC-BY-4.0';
  attribution: 'MD3 contributors';
}

/**
 * The public copy. Re-keyed by discipline, with the md3 id replaced by a hash
 * (the id carries course structure), module nodes dropped, rotation codes
 * filtered from topics, and the source cited as a REFERENCE: a guideline that
 * is readable but not FOSS is never quoted.
 */
export function toPublicQuestion(
  question: MirrorQuestionInput,
  discipline: CohortDiscipline,
  citation: MirrorCitation,
  references?: ReferenceIndex,
): PublicMirrorQuestion {
  const verified = references?.[citation.sourceSlug ?? ''];
  // Opaque on purpose: bank ids carry course structure (`w2resp-`, `legacy-`,
  // `mdx-haem-neuro-onc-`), and stripping known prefixes fails open on the next one.
  const digest = createHash('sha256').update(question.id).digest('hex');
  return {
    id: `open:${discipline}:q-${digest.slice(0, 12)}:v1`,
    origin: `md3:${digest.slice(0, 16)}`,
    discipline,
    stem: question.stem,
    options: question.options.map((o) => ({ label: o.label, text: o.text, isCorrect: !!o.isCorrect, explanation: o.explanation ?? '' })),
    context: question.context ?? null,
    topics: (question.topics ?? []).filter((t) => !ROTATION_CODES.has(t.toLowerCase())),
    difficulty: question.difficulty ?? null,
    questionType: question.questionType ?? null,
    reference: verified
      ? { title: verified.title, publisher: verified.publisher, url: verified.url }
      : { title: citation.paperTitle ?? null, url: citation.url ?? null },
    licence: 'CC-BY-4.0',
    attribution: 'MD3 contributors',
  };
}

/** A review of one public copy's exact wording. */
export interface MirrorReview { verdict: 'passed' | 'needs-fix'; contentHash: string; reviewer: string; reviewedAt: string }
export type ReviewLedger = Readonly<Record<string, MirrorReview>>;

/** sha256 of everything a learner reads in the public copy. */
export function publicContentHash(q: PublicMirrorQuestion): string {
  const read = { stem: q.stem, options: q.options, context: q.context, reference: q.reference };
  return createHash('sha256').update(JSON.stringify(read)).digest('hex');
}

/**
 * A 'supports' grounding verdict covers the key's claim, not every sentence the
 * item makes: measured 2026-09-23, 18 of 50 grounded questions still
 * contradicted their guideline in an explanation or the context. So a question
 * also needs an independent review that PASSED on its current wording.
 */
export function reviewAllowsPublication(q: PublicMirrorQuestion, ledger: ReviewLedger): boolean {
  const review = ledger[q.id];
  return review?.verdict === 'passed' && review.contentHash === publicContentHash(q);
}

