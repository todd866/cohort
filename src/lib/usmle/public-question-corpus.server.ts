import 'server-only';

import checkedInSourceRegistry from '../../../open-content/usmle/step1/sources.json';
import { prisma, type ExtendedPrismaClient } from '@/lib/prisma';
import { withDefaultQuestionServingPolicy } from '@/lib/questions/source-policy';
import {
  openUsmlePassageKey,
  parseOpenUsmleSourceRegistry,
  validateOpenUsmleSourceReference,
  type OpenUsmleSourceRegistry,
} from './open-source-registry';
import {
  decidePublicUsmleQuestion,
  USMLE_STEP1_PUBLIC_MODULE,
  type PublicUsmleDecision,
  type PublicUsmleProvenanceV1,
  type PublicUsmleQuestionCandidate,
} from './public-corpus';
import {
  CHECKED_IN_OPEN_USMLE_RELEASE,
} from './public-release-bundle';
import type { OpenUsmleReleaseManifest } from './public-release';
import {
  PUBLIC_USMLE_STORED_QUESTION_SELECT,
  publicUsmleServingFingerprint,
  type PublicUsmleStoredQuestion,
} from './public-serving-fingerprint';

type PublicUsmleQuestionRow = PublicUsmleStoredQuestion;

export type PublicUsmleQuestion = Omit<
  PublicUsmleQuestionRow,
  'source' | 'sourceFile' | 'contentState' | 'excluded' | 'citations' | 'annotations'
> & {
  /** Checked-in, source-recomputed fingerprint bound to every opaque delivery. */
  releaseFingerprint: string;
  publicProvenance: PublicUsmleProvenanceV1;
  renderEvidenceQuote: boolean;
  /** Registry-resolved, public-only citation. Never contains raw DB provenance. */
  resolvedCitation: PublicUsmleResolvedCitation | null;
};

export interface PublicUsmleResolvedCitation {
  kind: 'reference' | 'passage';
  title: string;
  publisher: string;
  canonicalUrl: string;
  attribution: string;
  licence: { id: string; url: string };
  passageLocator: string | null;
  quote?: string;
}

export type PublicUsmleRegistryExclusionReason =
  | 'evidence-source-not-registered'
  | 'evidence-passage-not-registered'
  | 'evidence-licence-mismatch'
  | 'evidence-reference-invalid'
  | 'release-content-drift'
  | 'not-release-manifest-member';

export type PublicUsmleServerDecision = PublicUsmleDecision | {
  eligible: false;
  reason: PublicUsmleRegistryExclusionReason;
  detail: string;
};

export interface PublicUsmleCorpusDecision {
  questionId: string;
  decision: PublicUsmleServerDecision;
}

export interface PublicUsmleQuestionCorpus {
  questions: PublicUsmleQuestion[];
  /** Server-side audit trail explaining every accepted/rejected candidate row. */
  decisions: PublicUsmleCorpusDecision[];
}

type QuestionStore = Pick<ExtendedPrismaClient, 'question'>;

const CHECKED_IN_SOURCE_REGISTRY = parseOpenUsmleSourceRegistry(checkedInSourceRegistry);
const PRIVATE_CORPUS_FIELDS = [
  'source',
  'sourceFile',
  'contentState',
  'excluded',
  'citations',
  'annotations',
] as const;

function stripPrivateCorpusFields(
  row: PublicUsmleQuestionRow,
): Omit<
  PublicUsmleQuestionRow,
  'source' | 'sourceFile' | 'contentState' | 'excluded' | 'citations' | 'annotations'
> {
  const publicRow = { ...row };
  for (const field of PRIVATE_CORPUS_FIELDS) {
    Reflect.deleteProperty(publicRow, field);
  }
  return publicRow;
}

type CitationResolution =
  | { ok: true; citation: PublicUsmleResolvedCitation | null }
  | { ok: false; reason: PublicUsmleRegistryExclusionReason; detail: string };

function resolvePublicCitation(
  provenance: PublicUsmleProvenanceV1,
  renderEvidenceQuote: boolean,
  registry: OpenUsmleSourceRegistry,
): CitationResolution {
  const evidence = provenance.evidence;
  if (evidence.kind === 'none') return { ok: true, citation: null };

  const errors = validateOpenUsmleSourceReference(registry, evidence);
  if (errors.some((error) => error.startsWith('Unknown source '))) {
    return {
      ok: false,
      reason: 'evidence-source-not-registered',
      detail: 'evidence source is absent from the checked-in source registry',
    };
  }
  if (errors.some((error) => error.startsWith('Unknown passage '))) {
    return {
      ok: false,
      reason: 'evidence-passage-not-registered',
      detail: 'evidence passage is absent from the checked-in source registry',
    };
  }
  if (errors.some((error) => error.startsWith('Licence mismatch '))) {
    return {
      ok: false,
      reason: 'evidence-licence-mismatch',
      detail: 'evidence licence does not match the checked-in source registry',
    };
  }
  if (errors.length > 0) {
    return {
      ok: false,
      reason: 'evidence-reference-invalid',
      detail: 'evidence reference failed checked-in source-registry validation',
    };
  }

  const source = registry.sourceById.get(evidence.sourceId);
  if (!source) {
    return {
      ok: false,
      reason: 'evidence-source-not-registered',
      detail: 'evidence source is absent from the checked-in source registry',
    };
  }
  const passage = evidence.kind === 'passage'
    ? registry.passageByKey.get(openUsmlePassageKey(evidence.sourceId, evidence.passageId))
    : undefined;
  if (evidence.kind === 'passage' && !passage) {
    return {
      ok: false,
      reason: 'evidence-passage-not-registered',
      detail: 'evidence passage is absent from the checked-in source registry',
    };
  }

  return {
    ok: true,
    citation: {
      kind: evidence.kind,
      title: source.title,
      publisher: source.publisher,
      canonicalUrl: source.canonicalUrl,
      attribution: source.attribution,
      licence: { id: source.licence.id, url: source.licence.url },
      passageLocator: passage?.locator ?? null,
      ...(renderEvidenceQuote && passage?.quote ? { quote: passage.quote } : {}),
    },
  };
}

/**
 * Load the public Step 1 question corpus without exposing a route or UI.
 *
 * The database query aggregates by cross-list membership, never by primary
 * rotation. Every returned row then passes the pure provenance contract; raw
 * citation/annotation metadata is deliberately removed from the public result.
 */
export async function loadPublicUsmleQuestionCorpus(
  store: QuestionStore = prisma,
  sourceRegistry: OpenUsmleSourceRegistry = CHECKED_IN_SOURCE_REGISTRY,
  releaseManifest: OpenUsmleReleaseManifest = CHECKED_IN_OPEN_USMLE_RELEASE,
): Promise<PublicUsmleQuestionCorpus> {
  const releaseIds = new Set(releaseManifest.questionIds);
  const rows = await store.question.findMany({
    where: withDefaultQuestionServingPolicy({
      id: { in: releaseManifest.questionIds },
      moduleNodes: { has: USMLE_STEP1_PUBLIC_MODULE },
      excluded: false,
      contentState: { in: ['validated', 'enhanced', 'cited', 'production'] },
    }),
    select: PUBLIC_USMLE_STORED_QUESTION_SELECT,
    orderBy: { id: 'asc' },
  });

  const questions: PublicUsmleQuestion[] = [];
  const decisions: PublicUsmleCorpusDecision[] = [];

  for (const row of rows) {
    if (!releaseIds.has(row.id)) {
      decisions.push({
        questionId: row.id,
        decision: {
          eligible: false,
          reason: 'not-release-manifest-member',
          detail: 'question is absent from the checked-in release allowlist',
        },
      });
      continue;
    }
    const releaseFingerprint = releaseManifest.questionFingerprints[row.id];
    if (
      !releaseFingerprint
      || publicUsmleServingFingerprint(row) !== releaseFingerprint
    ) {
      decisions.push({
        questionId: row.id,
        decision: {
          eligible: false,
          reason: 'release-content-drift',
          detail: 'serving row differs from the checked-in release source',
        },
      });
      continue;
    }
    const decision = decidePublicUsmleQuestion(row satisfies PublicUsmleQuestionCandidate);
    if (!decision.eligible) {
      decisions.push({ questionId: row.id, decision });
      continue;
    }

    // The database envelope is only a pointer. Re-resolve it against the
    // statically bundled, checked-in registry on every load so a stale or
    // forged DB source/passage/licence claim cannot authorize delivery alone.
    const citationResolution = resolvePublicCitation(
      decision.provenance,
      decision.renderEvidenceQuote,
      sourceRegistry,
    );
    if (!citationResolution.ok) {
      decisions.push({
        questionId: row.id,
        decision: {
          eligible: false,
          reason: citationResolution.reason,
          detail: citationResolution.detail,
        },
      });
      continue;
    }

    decisions.push({ questionId: row.id, decision });

    questions.push({
      ...stripPrivateCorpusFields(row),
      releaseFingerprint,
      publicProvenance: decision.provenance,
      renderEvidenceQuote: decision.renderEvidenceQuote,
      resolvedCitation: citationResolution.citation,
    });
  }

  return { questions, decisions };
}
