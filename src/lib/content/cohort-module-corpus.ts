import { createHash } from 'node:crypto';
import { COHORT_DISCIPLINES, COHORT_MODULE_ROTATION, type PublicMirrorQuestion } from './cohort-mirror';
import type { CuratedQuestion } from '@/lib/question-bank/types';
import { buildPublicUsmleReleaseFingerprints } from '@/lib/usmle/public-serving-drift';

/**
 * Whether a generated Cohort module question may be served on cohort.md.
 *
 * Cohort is md3 minus the copyright tier. Rights-clean md3 questions are
 * generated into open-content/modules/questions/<discipline>/ (the mirror,
 * docs/designs/2026-09-23-cohort-mirror.md) and served from their own rows.
 * This is their gate, separate from the Step 1 gate on purpose:
 * `decidePublicUsmleQuestion` demands a FOSS passage and must not be loosened.
 * A mirrored item instead cites a verified guideline as a REFERENCE, never
 * quoted, because a guideline can be the best authority and still not be ours
 * to republish. It also needs a passed review of exactly the words it ships.
 *
 * Pure and fail-closed: every reason to refuse is checked, and an unexpected
 * shape is a refusal.
 */

export { COHORT_MODULE_ROTATION };

export interface CohortModuleSource {
  title: string;
  publisher: string | null;
  url: string;
  verifiedAt: string;
  /** 'verify': readable and citable, not redistributable. 'foss': both. */
  licence: { cls: 'verify' | 'foss' };
}

export interface CohortModuleSourceRegistry {
  schemaVersion: 1;
  sources: Readonly<Record<string, CohortModuleSource>>;
}

export interface CohortModuleOption { label: string; text: string; isCorrect: boolean; explanation: string }

export interface CohortModuleQuestionFile {
  id: string;
  rotation: typeof COHORT_MODULE_ROTATION;
  moduleNodes: string[];
  topics: string[];
  questionType: string | null;
  difficulty: string | null;
  stem: string;
  options: CohortModuleOption[];
  context: string | null;
  imageUrl?: string | null;
  publicModule: {
    schemaVersion: 1;
    origin: 'mirrored';
    discipline: string;
    /** Opaque trace to the md3 item it was generated from. */
    mirroredFrom: string;
    itemText: { licence: 'CC-BY-4.0'; attribution: string };
    evidence: { kind: 'reference'; sourceId: string };
    review: { verdict: 'passed' | 'needs-fix'; contentHash: string };
  };
}

export type CohortModuleDecision =
  | { eligible: true }
  | { eligible: false; reason: string; detail: string };

const DISCIPLINES: ReadonlySet<string> = new Set(COHORT_DISCIPLINES);

/** sha256 of everything a learner reads, plus the evidence it is judged on. */
export function moduleItemContentHash(item: CohortModuleQuestionFile): string {
  const read = {
    stem: item.stem,
    context: item.context,
    options: item.options.map((o) => ({ label: o.label, text: o.text, isCorrect: o.isCorrect, explanation: o.explanation })),
    evidence: item.publicModule.evidence,
  };
  return createHash('sha256').update(JSON.stringify(read)).digest('hex');
}

const refuse = (reason: string, detail: string): CohortModuleDecision => ({ eligible: false, reason, detail });

export function decidePublicModuleQuestion(
  item: CohortModuleQuestionFile,
  registry: CohortModuleSourceRegistry,
): CohortModuleDecision {
  const meta = item.publicModule;
  if (!meta || meta.schemaVersion !== 1) return refuse('no-provenance', 'publicModule schemaVersion 1 is required');
  if (meta.origin !== 'mirrored') return refuse('not-mirrored', `origin ${String(meta.origin)} is not mirrored`);
  if (meta.itemText?.licence !== 'CC-BY-4.0') return refuse('item-licence', `item text licence ${String(meta.itemText?.licence)}`);

  if (!DISCIPLINES.has(meta.discipline)) return refuse('unknown-discipline', `discipline ${meta.discipline} is not a Cohort module`);
  if (item.rotation !== COHORT_MODULE_ROTATION || !item.moduleNodes.includes(`cohort/${meta.discipline}`)) {
    return refuse('module-mismatch', `moduleNodes must include cohort/${meta.discipline}`);
  }

  if (item.imageUrl) return refuse('image-not-allowed', 'mirrored items ship without images until the figure lane covers them');

  const evidence = meta.evidence as { kind?: string; sourceId?: string; quote?: unknown } | undefined;
  if (evidence?.kind !== 'reference' || !evidence.sourceId) return refuse('no-reference', 'evidence must be a reference to a registered source');
  if ('quote' in evidence) return refuse('reference-quoted', 'a reference is cited, never reproduced');
  const source = registry.sources[evidence.sourceId];
  if (!source || !/^https:\/\//.test(source.url) || !source.verifiedAt) {
    return refuse('unknown-source', `source ${evidence.sourceId} is not a verified registry entry`);
  }

  if (meta.review?.verdict !== 'passed') return refuse('review-not-passed', 'the item needs a passed review');
  if (meta.review.contentHash !== moduleItemContentHash(item)) {
    return refuse('review-stale', 'the wording changed after its review');
  }
  return { eligible: true };
}

export interface VerifiedReferenceEntry { title: string; publisher: string | null; url: string; verifiedAt: string }

export interface CohortModuleRelease {
  schemaVersion: 1;
  questionIds: string[];
  /** The registry source each question cites; the database row does not carry it. */
  questionSources: Record<string, string>;
  /** Serving fingerprint of each seeded row; the Cohort host refuses any row that drifted. */
  questionFingerprints?: Record<string, string>;
}

/**
 * The fingerprint a seeded row must carry, computed from the questions as the
 * loader reads them (sourceFile included), with the same projection the seed
 * applies. Same function Step 1 uses, so the two hosts cannot disagree.
 */
export function moduleReleaseFingerprints(questions: CuratedQuestion[]): Record<string, string> {
  return buildPublicUsmleReleaseFingerprints(questions);
}

export interface CohortModuleArtifacts {
  /** Repo-relative path → file. */
  files: Map<string, CohortModuleQuestionFile>;
  sources: CohortModuleSourceRegistry;
  release: CohortModuleRelease;
}

/**
 * Cleared public copies (each already PASSED review on its exact wording) →
 * the committed module files, the registry of the sources they cite, and the
 * release list. Deterministic, so regenerating unchanged input changes no byte.
 */
export function buildModuleArtifacts(
  items: ReadonlyArray<{ question: PublicMirrorQuestion; sourceId: string }>,
  references: Readonly<Record<string, VerifiedReferenceEntry>>,
): CohortModuleArtifacts {
  const files = new Map<string, CohortModuleQuestionFile>();
  const sources: Record<string, CohortModuleSource> = {};
  const ordered = [...items].sort((a, b) => a.question.id.localeCompare(b.question.id));

  for (const { question, sourceId } of ordered) {
    const reference = references[sourceId];
    if (!reference) throw new Error(`cited source ${sourceId} has no verified reference`);
    sources[sourceId] = { ...reference, licence: { cls: 'verify' } };

    if (question.options.filter((o) => o.isCorrect === true).length !== 1) {
      throw new Error(`${question.id} needs exactly one correct option`);
    }
    const unexplained = question.options.find((o) => !o.explanation?.trim());
    if (unexplained) throw new Error(`${question.id} option ${unexplained.label} has no explanation`);

    const slug = /^open:[a-z-]+:(q-[0-9a-f]{12}):v1$/.exec(question.id)?.[1];
    if (!slug) throw new Error(`unexpected public id ${question.id}`);
    const file: CohortModuleQuestionFile = {
      id: `bank:cohort:${question.discipline}:${slug}:v1`,
      rotation: COHORT_MODULE_ROTATION,
      moduleNodes: [`cohort/${question.discipline}`],
      topics: question.topics,
      questionType: question.questionType,
      difficulty: question.difficulty,
      stem: question.stem,
      options: question.options.map((o) => ({ label: o.label, text: o.text, isCorrect: o.isCorrect === true, explanation: o.explanation ?? '' })),
      context: question.context,
      publicModule: {
        schemaVersion: 1,
        origin: 'mirrored',
        discipline: question.discipline,
        mirroredFrom: question.origin,
        itemText: { licence: 'CC-BY-4.0', attribution: 'MD3 contributors' },
        evidence: { kind: 'reference', sourceId },
        review: { verdict: 'passed', contentHash: '' },
      },
    };
    file.publicModule.review.contentHash = moduleItemContentHash(file);
    files.set(`open-content/modules/questions/${question.discipline}/${slug}.v1.json`, file);
  }

  const sortedSources = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
  return {
    files,
    sources: { schemaVersion: 1, sources: sortedSources },
    release: {
      schemaVersion: 1,
      questionIds: [...files.values()].map((f) => f.id).sort(),
      questionSources: Object.fromEntries(
        [...files.values()].map((f) => [f.id, f.publicModule.evidence.sourceId] as const).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
  };
}
