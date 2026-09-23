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
import type { ProvenanceResult } from './rights-provenance';

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
