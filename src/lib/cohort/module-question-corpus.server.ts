import 'server-only';

import checkedInRelease from '../../../open-content/modules/release-v1.json';
import checkedInSources from '../../../open-content/modules/sources.json';
import originalRelease from '../../../open-content/modules/original-questions-release-v1.json';
import originalSources from '../../../open-content/modules/original-questions-sources.json';
import { prisma, type ExtendedPrismaClient } from '@/lib/prisma';
import { withDefaultQuestionServingPolicy } from '@/lib/questions/source-policy';
import {
  COHORT_MODULE_ROTATION,
  moduleSourceFingerprint,
  type CohortModuleRelease,
  type CohortModuleSourceRegistry,
} from '@/lib/content/cohort-module-corpus';
import {
  loadPublicUsmleQuestionCorpus,
  type PublicUsmleQuestion,
  type PublicUsmleQuestionCorpus,
} from '@/lib/usmle/public-question-corpus.server';
import {
  PUBLIC_USMLE_STORED_QUESTION_SELECT,
  publicUsmleServingFingerprint,
  type PublicUsmleStoredQuestion,
} from '@/lib/usmle/public-serving-fingerprint';

/**
 * The Cohort module corpus: rights-clean md3 questions mirrored as their own
 * `cohort-open` rows (docs/designs/2026-09-23-cohort-mirror.md).
 *
 * Served in the Step 1 question shape so the Cohort turn can use them unchanged,
 * and gated the same way: every row must be a member of the checked-in release,
 * match its reviewed serving fingerprint exactly, and resolve its guideline in
 * the checked-in registry. The database is only a pointer; the checked-in
 * release decides. The guideline is cited as a REFERENCE and never quoted,
 * because it may be readable but not ours to republish.
 */

export type CohortModuleServingRelease = CohortModuleRelease & {
  questionFingerprints: Record<string, string>;
};

export type CohortModuleExclusionReason =
  | 'not-release-manifest-member'
  | 'release-content-drift'
  | 'not-cohort-module-row'
  | 'unservable-state'
  | 'evidence-source-not-registered'
  | 'evidence-source-drift';

export type CohortModuleServerDecision =
  | { eligible: true }
  | { eligible: false; reason: CohortModuleExclusionReason; detail: string };

export interface CohortModuleQuestionCorpus {
  questions: PublicUsmleQuestion[];
  decisions: Array<{ questionId: string; decision: CohortModuleServerDecision }>;
}

type QuestionStore = Pick<ExtendedPrismaClient, 'question'>;

const CHECKED_IN_RELEASE = checkedInRelease as CohortModuleServingRelease;
const CHECKED_IN_REGISTRY = checkedInSources as CohortModuleSourceRegistry;
const CHECKED_IN_ORIGINAL_RELEASE = originalRelease as CohortModuleServingRelease;
const CHECKED_IN_ORIGINAL_REGISTRY = originalSources as CohortModuleSourceRegistry;
const CHECKED_IN_RELEASE_ALL: CohortModuleServingRelease = {
  schemaVersion: 1,
  questionIds: [...CHECKED_IN_RELEASE.questionIds, ...CHECKED_IN_ORIGINAL_RELEASE.questionIds],
  questionSources: { ...CHECKED_IN_RELEASE.questionSources, ...CHECKED_IN_ORIGINAL_RELEASE.questionSources },
  questionFingerprints: { ...CHECKED_IN_RELEASE.questionFingerprints, ...CHECKED_IN_ORIGINAL_RELEASE.questionFingerprints },
  questionSourceFingerprints: CHECKED_IN_ORIGINAL_RELEASE.questionSourceFingerprints,
};
const CHECKED_IN_REGISTRY_ALL: CohortModuleSourceRegistry = {
  schemaVersion: 1,
  sources: { ...CHECKED_IN_REGISTRY.sources, ...CHECKED_IN_ORIGINAL_REGISTRY.sources },
};
const SERVABLE_STATES = ['validated', 'enhanced', 'cited', 'production'];
const PRIVATE_FIELDS = ['source', 'sourceFile', 'contentState', 'excluded', 'citations', 'annotations'] as const;

const refuse = (reason: CohortModuleExclusionReason, detail: string): CohortModuleServerDecision => ({
  eligible: false, reason, detail,
});

function disciplineOf(id: string): string | null {
  return /^bank:cohort:([a-z-]+):q-[0-9a-f]{12}:v1$/.exec(id)?.[1] ?? null;
}

/** Pure: decide and project each stored row. Exported for the contract test. */
export function buildCohortModuleCorpus(
  rows: readonly PublicUsmleStoredQuestion[],
  release: CohortModuleServingRelease,
  registry: CohortModuleSourceRegistry,
): CohortModuleQuestionCorpus {
  const released = new Set(release.questionIds);
  const questions: PublicUsmleQuestion[] = [];
  const decisions: CohortModuleQuestionCorpus['decisions'] = [];

  for (const row of rows) {
    const decide = (decision: CohortModuleServerDecision) => decisions.push({ questionId: row.id, decision });
    const releaseFingerprint = release.questionFingerprints[row.id];
    const discipline = disciplineOf(row.id);
    if (!released.has(row.id) || !releaseFingerprint) {
      decide(refuse('not-release-manifest-member', 'question is absent from the checked-in module release'));
      continue;
    }
    if (row.rotation !== COHORT_MODULE_ROTATION || !discipline || !row.moduleNodes.includes(`cohort/${discipline}`)) {
      decide(refuse('not-cohort-module-row', 'row is not a cohort-open module row'));
      continue;
    }
    if (row.source !== 'bank' || row.excluded || !SERVABLE_STATES.includes(row.contentState)) {
      decide(refuse('unservable-state', `row is ${row.excluded ? 'excluded' : row.contentState}`));
      continue;
    }
    if (publicUsmleServingFingerprint(row) !== releaseFingerprint) {
      decide(refuse('release-content-drift', 'serving row differs from the checked-in release source'));
      continue;
    }
    const sourceId = release.questionSources[row.id];
    const source = sourceId ? registry.sources[sourceId] : undefined;
    if (!sourceId || !source || !/^https:\/\//.test(source.url) || !source.verifiedAt) {
      decide(refuse('evidence-source-not-registered', 'cited source is absent from the checked-in registry'));
      continue;
    }

    const citationFingerprint = release.questionSourceFingerprints?.[row.id];
    const originalLane = row.sourceFile?.startsWith('open-content/modules/original-questions/');
    if ((originalLane && !citationFingerprint) || (citationFingerprint && citationFingerprint !== moduleSourceFingerprint(sourceId, source))) {
      decide(refuse('evidence-source-drift', 'citation differs from its reviewed release'));
      continue;
    }

    const publicRow = { ...row } as Partial<PublicUsmleStoredQuestion>;
    for (const field of PRIVATE_FIELDS) Reflect.deleteProperty(publicRow, field);
    const publisher = source.publisher ?? source.title;
    questions.push({
      ...(publicRow as Omit<PublicUsmleStoredQuestion, (typeof PRIVATE_FIELDS)[number]>),
      releaseFingerprint,
      publicProvenance: {
        schemaVersion: 1,
        origin: 'authored',
        itemText: { licence: 'CC-BY-4.0', attribution: 'MD3 contributors' },
        evidence: { kind: 'reference', sourceId, licence: { cls: 'verify', id: 'reference-only' } },
      },
      renderEvidenceQuote: false,
      resolvedCitation: {
        kind: 'reference',
        title: source.title,
        publisher,
        canonicalUrl: source.url,
        attribution: publisher,
        // Rights stay with the publisher; the link is where they are stated.
        licence: { id: 'reference-only', url: source.url },
        passageLocator: null,
      },
    });
    decide({ eligible: true });
  }

  return { questions, decisions };
}

export async function loadCohortModuleQuestionCorpus(
  store: QuestionStore = prisma,
  release: CohortModuleServingRelease = CHECKED_IN_RELEASE_ALL,
  registry: CohortModuleSourceRegistry = CHECKED_IN_REGISTRY_ALL,
): Promise<CohortModuleQuestionCorpus> {
  const rows = await store.question.findMany({
    where: withDefaultQuestionServingPolicy({
      id: { in: release.questionIds },
      rotation: COHORT_MODULE_ROTATION,
      excluded: false,
      contentState: { in: SERVABLE_STATES },
    }),
    select: PUBLIC_USMLE_STORED_QUESTION_SELECT,
    orderBy: { id: 'asc' },
  });
  return buildCohortModuleCorpus(rows, release, registry);
}

/**
 * Everything the Cohort host may serve: the Step 1 corpus plus the mirrored
 * modules. The turn scopes a module to its chosen topic; replay and answer
 * checks need both, since a delivery can be either. Only the Cohort surface
 * uses this; the md3-hosted Step 1 surface keeps the Step 1 corpus alone.
 */
export async function loadCohortServableCorpus(
  store: QuestionStore = prisma,
): Promise<PublicUsmleQuestionCorpus> {
  // Sequential: in the turn both queries share one interactive transaction, which
  // does not reliably support concurrent statements.
  const step1 = await loadPublicUsmleQuestionCorpus(store);
  const modules = await loadCohortModuleQuestionCorpus(store);
  // Ids cannot collide (bank:cohort:* vs the Step 1 namespace); refuse if they ever do.
  const step1Ids = new Set(step1.questions.map((question) => question.id));
  const collision = modules.questions.find((question) => step1Ids.has(question.id));
  if (collision) throw new Error(`Cohort corpus id collision: ${collision.id}`);
  return {
    questions: [...step1.questions, ...modules.questions],
    decisions: step1.decisions,
  };
}
