import type { CuratedQuestion } from '@/lib/question-bank/types';
import {
  validateOpenUsmleSourceReference,
  type OpenUsmleSourceRegistry,
} from './open-source-registry';
import {
  buildQuestionCitationEnvelope,
  decidePublicUsmleQuestion,
  USMLE_STEP1_PUBLIC_MODULE,
  type PublicUsmleDecision,
} from './public-corpus';
import {
  auditStep1RawAnswerKey,
  step1RawAnswerKeyFailureMessages,
  type Step1RawAnswerKeyAudit,
} from './raw-answer-key-quality';

export type PublicUsmleAuditLane =
  | 'availability'
  | 'eligible'
  | 'grounding'
  | 'item-quality'
  | 'media'
  | 'metadata'
  | 'out-of-scope'
  | 'restricted-origin'
  | 'rights';

export type PublicUsmleAuditReason =
  | PublicUsmleDecision['reason']
  | 'evidence-licence-mismatch'
  | 'evidence-passage-not-registered'
  | 'evidence-reference-invalid'
  | 'evidence-source-not-registered'
  | 'item-mechanical-flaw';

const REASON_LANES: Record<PublicUsmleAuditReason, PublicUsmleAuditLane> = {
  'eligible-authored': 'eligible',
  'eligible-generated': 'eligible',
  'not-step1-member': 'out-of-scope',
  excluded: 'availability',
  'unservable-state': 'availability',
  'known-anking-source': 'restricted-origin',
  'known-y3g-source': 'restricted-origin',
  'known-instagram-source': 'restricted-origin',
  'known-first-aid-source': 'restricted-origin',
  'media-provenance-required': 'media',
  'provenance-missing': 'metadata',
  'provenance-invalid': 'metadata',
  'origin-not-public': 'restricted-origin',
  'item-text-licence-not-public': 'rights',
  'authored-grounding-required': 'grounding',
  'generated-grounding-required': 'grounding',
  'authored-evidence-not-foss': 'rights',
  'generated-evidence-not-foss': 'grounding',
  'evidence-licence-mismatch': 'rights',
  'evidence-passage-not-registered': 'grounding',
  'evidence-reference-invalid': 'grounding',
  'evidence-source-not-registered': 'grounding',
  'item-mechanical-flaw': 'item-quality',
};

export interface PublicUsmleAuditItem {
  questionId: string;
  rotation: string;
  sourceFile: string | null;
  eligible: boolean;
  reason: PublicUsmleAuditReason;
  lane: PublicUsmleAuditLane;
  detail: string;
}

export interface PublicUsmleCorpusAuditReport {
  schemaVersion: 1;
  basis: 'source-projection';
  module: typeof USMLE_STEP1_PUBLIC_MODULE;
  membersOnly: boolean;
  baseline: {
    manifestQuestionCount: number;
    eligibleQuestionCount: number;
    blockerCount: number;
  } | null;
  /** Content-safe verification receipt for the checked-in citation registry. */
  sourceRegistry: {
    verifiedAt: string;
    quoteSetSha256: string;
    registrySha256: string;
    sourceCount: number;
    passageCount: number;
  };
  summary: {
    sourceQuestionCount: number;
    auditedQuestionCount: number;
    skippedNonMemberCount: number;
    eligibleCount: number;
    blockerCount: number;
  };
  countsByLane: Record<string, number>;
  countsByReason: Record<string, number>;
  /** Aggregate-only raw-position audit; never identifies an item's answer. */
  rawAnswerKey: Step1RawAnswerKeyAudit;
  /** Safe operator metadata only; never stems, options, explanations, or raw provenance. */
  items: PublicUsmleAuditItem[];
}

function sortedCounts(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (
    a < b ? -1 : a > b ? 1 : 0
  )));
}

function sourceReferenceFailure(
  question: CuratedQuestion,
  sourceRegistry: OpenUsmleSourceRegistry,
): Pick<PublicUsmleAuditItem, 'reason' | 'detail'> | null {
  if (!question.publicUsmle) return null;
  const errors = validateOpenUsmleSourceReference(
    sourceRegistry,
    question.publicUsmle.evidence,
  );
  if (errors.length === 0) return null;

  // The registry validator owns the source-level truth. Map its deliberately
  // bounded messages to durable report codes, but do not copy evidence IDs or
  // any source/question content into the audit artifact.
  if (errors.some((error) => error.startsWith('Unknown source '))) {
    return {
      reason: 'evidence-source-not-registered',
      detail: 'evidence source is absent from the checked-in source registry',
    };
  }
  if (errors.some((error) => error.startsWith('Licence mismatch '))) {
    return {
      reason: 'evidence-licence-mismatch',
      detail: 'question evidence licence does not match the checked-in source registry',
    };
  }
  if (errors.some((error) => error.startsWith('Unknown passage '))) {
    return {
      reason: 'evidence-passage-not-registered',
      detail: 'evidence passage is absent from the checked-in source registry',
    };
  }
  return {
    reason: 'evidence-reference-invalid',
    detail: 'evidence reference failed checked-in source-registry validation',
  };
}

/**
 * Project source files through the canonical public-corpus policy without a DB.
 *
 * Bank seeding writes `source=bank` and `contentState=enhanced`; this report
 * models that prospective state and overlays the tracked disk exclusion list.
 */
export function buildPublicUsmleSourceAudit(
  questions: CuratedQuestion[],
  excludedQuestionIds: ReadonlySet<string>,
  sourceRegistry: OpenUsmleSourceRegistry,
  options: {
    membersOnly?: boolean;
    baselineQuestionIds?: ReadonlySet<string> | null;
    mechanicalFlawQuestionIds?: ReadonlySet<string>;
  } = {},
): PublicUsmleCorpusAuditReport {
  const membersOnly = options.membersOnly === true;
  const sourceQuestionCount = questions.length;
  const scopedQuestions = membersOnly
    ? questions.filter((question) => (
        question.moduleNodes?.includes(USMLE_STEP1_PUBLIC_MODULE) === true
      ))
    : questions;
  const scopedQuestionById = new Map(
    scopedQuestions.map((question) => [question.id, question]),
  );
  const rawAnswerKeyQuestions = options.baselineQuestionIds
    ? Array.from(options.baselineQuestionIds).flatMap((questionId) => {
        const question = scopedQuestionById.get(questionId);
        return question ? [question] : [];
      })
    : scopedQuestions;
  const rawAnswerKey = auditStep1RawAnswerKey(rawAnswerKeyQuestions);

  const items = scopedQuestions.map((question): PublicUsmleAuditItem => {
    const decision = decidePublicUsmleQuestion({
      id: question.id,
      rotation: question.rotation,
      moduleNodes: question.moduleNodes ?? [],
      source: 'bank',
      sourceFile: question.sourceFile ?? null,
      imageUrl: question.imageUrl ?? null,
      contentState: 'enhanced',
      excluded: excludedQuestionIds.has(question.id),
      citations: buildQuestionCitationEnvelope(question.cite, question.publicUsmle),
      annotations: question.annotations ?? null,
    });
    let eligible = decision.eligible;
    let reason: PublicUsmleAuditReason = decision.reason;
    let detail = decision.eligible
      ? 'passes the public USMLE source projection'
      : decision.detail;

    // Legal/provenance failures remain the primary work item. Once those pass,
    // cross-check the evidence pointer against the checked-in source registry.
    const referenceFailure = decision.eligible
      ? sourceReferenceFailure(question, sourceRegistry)
      : null;
    if (decision.eligible && referenceFailure) {
      eligible = false;
      reason = referenceFailure.reason;
      detail = referenceFailure.detail;
    } else if (
      decision.eligible
      && options.mechanicalFlawQuestionIds?.has(question.id)
    ) {
      eligible = false;
      reason = 'item-mechanical-flaw';
      detail = 'deterministic Step 1 item-writing rubric found a release-blocking flaw';
    }

    return {
      questionId: question.id,
      rotation: question.rotation,
      sourceFile: question.sourceFile ?? null,
      eligible,
      reason,
      lane: REASON_LANES[reason],
      detail,
    };
  }).sort((a, b) => (
    a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0
  ));

  const eligibleCount = items.filter((item) => item.eligible).length;
  const blockerCount = items.length - eligibleCount;
  const baseline = options.baselineQuestionIds
    ? (() => {
        const eligibleQuestionCount = items.filter((item) => (
          item.eligible && options.baselineQuestionIds?.has(item.questionId)
        )).length;
        return {
          manifestQuestionCount: options.baselineQuestionIds.size,
          eligibleQuestionCount,
          blockerCount: options.baselineQuestionIds.size - eligibleQuestionCount,
        };
      })()
    : null;
  return {
    schemaVersion: 1,
    basis: 'source-projection',
    module: USMLE_STEP1_PUBLIC_MODULE,
    membersOnly,
    baseline,
    sourceRegistry: {
      verifiedAt: sourceRegistry.verifiedAt,
      quoteSetSha256: sourceRegistry.quoteSetSha256,
      registrySha256: sourceRegistry.registrySha256,
      sourceCount: sourceRegistry.sources.length,
      passageCount: sourceRegistry.passageByKey.size,
    },
    summary: {
      sourceQuestionCount,
      auditedQuestionCount: items.length,
      skippedNonMemberCount: sourceQuestionCount - items.length,
      eligibleCount,
      blockerCount,
    },
    countsByLane: sortedCounts(items.map((item) => item.lane)),
    countsByReason: sortedCounts(items.map((item) => item.reason)),
    rawAnswerKey,
    items,
  };
}

/** Pure release-contract check; normal backlog audits deliberately do not call it. */
export function publicUsmleReleaseGateFailures(
  report: PublicUsmleCorpusAuditReport,
  minEligible: number,
): string[] {
  if (!Number.isInteger(minEligible) || minEligible < 0) {
    throw new Error('minEligible must be a non-negative integer');
  }
  const failures: string[] = [];
  if (report.summary.eligibleCount < minEligible) {
    failures.push(
      `eligible corpus has ${report.summary.eligibleCount} item(s); release requires at least ${minEligible}`,
    );
  }
  if (report.summary.blockerCount > 0) {
    failures.push(`${report.summary.blockerCount} audited item(s) fail public eligibility`);
  }
  if (report.baseline && report.baseline.eligibleQuestionCount < minEligible) {
    failures.push(
      `eligible baseline has ${report.baseline.eligibleQuestionCount} item(s); `
      + `release requires at least ${minEligible}`,
    );
  }
  if (report.baseline && report.baseline.blockerCount > 0) {
    failures.push(
      `${report.baseline.blockerCount} baseline item(s) fail public eligibility`,
    );
  }
  failures.push(...step1RawAnswerKeyFailureMessages(report.rawAnswerKey));
  return failures;
}
