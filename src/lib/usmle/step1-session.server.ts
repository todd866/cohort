import 'server-only';

import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { questionSuppressionKey } from '@/lib/knowledge/variant-suppression';
import { rankAdaptive, normaliseDifficulty, type DifficultyTier } from './step1-adaptive';
import { coerceScorableOptions } from '@/lib/question-validation';
import {
  PUBLIC_USMLE_DELIVERY_WRITE_CAPABILITY,
  recordQuestionAttemptFast,
  type RecordQuestionAttemptInput,
  type RecordQuestionAttemptResult,
} from '@/lib/review/record-question-attempt';
import { getStudyDayStart } from '@/lib/study-day';
import { isOpenFigurePath } from '@/lib/figures/open-figure-access';
import {
  parsePublicVisualAssetManifestV1,
  publicVisualAssetReleaseFailures,
} from '@/lib/cohort/public-visual-assets';
import publicVisualAssetManifestJson from '../../../open-content/usmle/step1/visual-assets-v1.json';
import { USMLE_STEP1_BASELINE_V1_MODULE } from './public-baseline';
import {
  loadPublicUsmleQuestionCorpus,
  type PublicUsmleQuestion,
  type PublicUsmleQuestionCorpus,
} from './public-question-corpus.server';
import type {
  Step1AnswerReveal,
  Step1Progress,
  Step1SessionMedia,
  Step1SessionItem,
  Step1SessionMode,
  Step1SessionResult,
} from './step1-contract';
import { step1MediaSourcePresentation } from './step1-media-source.server';

export type {
  Step1AnswerReveal,
  Step1Progress,
  Step1SessionItem,
  Step1SessionMode,
  Step1SessionResult,
} from './step1-contract';

export const USMLE_STEP1_BASELINE_MODULE = USMLE_STEP1_BASELINE_V1_MODULE;
const LEGACY_USMLE_STEP1_DELIVERY_CONTRACT = 'usmle-step1-delivery-v2' as const;
export const USMLE_STEP1_DELIVERY_CONTRACT = 'usmle-step1-delivery-v3' as const;
export type Step1DeliverySurface = 'usmle-step1' | 'cohort';

const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1_000;
const RECENT_ACTIVITY_MS = 7 * 24 * 60 * 60 * 1_000;
const DISPLAY_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const OPEN_STEP1_FIGURE_PREFIX = '/figures/usmle/step1/';
const publicVisualAssetManifest = parsePublicVisualAssetManifestV1(
  publicVisualAssetManifestJson,
  'foss',
);

export class Step1ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'Step1ApiError';
  }
}

export interface Step1HistoryRow {
  questionId: string;
  isCorrect: boolean;
  createdAt: Date;
  sessionType: string | null;
}

export interface Step1DeliveryPayload extends Prisma.InputJsonObject {
  contract: typeof USMLE_STEP1_DELIVERY_CONTRACT;
  mode: Step1SessionMode;
  /** Server-authored product surface; never accepted from the answer client. */
  surface: Step1DeliverySurface;
  displayToOriginal: Record<string, string>;
  contentHash: string;
  servingFingerprint: string;
}

interface ParsedStep1DeliveryPayload {
  contract:
    | typeof USMLE_STEP1_DELIVERY_CONTRACT
    | typeof LEGACY_USMLE_STEP1_DELIVERY_CONTRACT;
  mode: Step1SessionMode;
  surface: Step1DeliverySurface;
  displayToOriginal: Record<string, string>;
  contentHash: string;
  servingFingerprint: string;
}

/** The exact strict-write row. `itemId` and shuffle metadata never leave the server. */
export interface Step1DeliveryRow {
  id: string;
  userId: string;
  sessionId: string;
  batchId: string;
  itemType: 'question';
  itemId: string;
  rotation: string;
  week: number | null;
  decidedAt: Date;
  exposedAt: Date;
  decisionPath: 'usmle-step1-baseline-v1' | 'usmle-step1-daily-v1';
  deliveryPath: 'live';
  queueReason:
    | 'baseline-unseen'
    | 'daily-missed-or-stale'
    | 'daily-unseen'
    | 'daily-reinforcement'
    | 'hook-v1'
    | 'same-concept-remediation'
    | 'search-focus';
  position: number;
  rankInPool: number;
  poolSize: number;
  difficultyTier: string;
  variantGroupId: string | null;
  variantType: string | null;
  summary: string;
  payload: Step1DeliveryPayload;
}

interface Step1SessionDependencies {
  loadCorpus: () => Promise<PublicUsmleQuestionCorpus>;
  loadHistory: (userId: string, questionIds: string[]) => Promise<Step1HistoryRow[]>;
  persistDeliveries: (rows: Step1DeliveryRow[]) => Promise<number>;
  createId: () => string;
  random: () => number;
}

interface DeliverableOption {
  originalLabel: string;
  text: string;
  isCorrect: boolean;
  explanation: string | null;
  misconception: string | null;
}

interface RankedQuestion {
  question: PublicUsmleQuestion;
  reason: Step1DeliveryRow['queueReason'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionDetails(question: PublicUsmleQuestion): DeliverableOption[] | null {
  if (!Array.isArray(question.options)) return null;
  const scorable = coerceScorableOptions(question.options);
  if (
    scorable.length !== question.options.length
    || scorable.length < 4
    || scorable.length > DISPLAY_LABELS.length
    || scorable.filter((option) => option.isCorrect).length !== 1
  ) {
    return null;
  }

  const labels = new Set<string>();
  const details: DeliverableOption[] = [];
  for (let index = 0; index < scorable.length; index++) {
    const raw = question.options[index];
    if (!isRecord(raw)) return null;
    const originalLabel = scorable[index].label.trim().toUpperCase();
    if (!/^[A-Z]$/.test(originalLabel) || labels.has(originalLabel)) return null;
    labels.add(originalLabel);
    details.push({
      originalLabel,
      text: scorable[index].text,
      isCorrect: scorable[index].isCorrect,
      explanation: typeof raw.explanation === 'string' && raw.explanation.trim()
        ? raw.explanation.trim()
        : null,
      misconception: typeof raw.misconception === 'string' && raw.misconception.trim()
        ? raw.misconception.trim()
        : null,
    });
  }
  return details;
}

export function isDeliverableStep1Question(question: PublicUsmleQuestion): boolean {
  return question.stem.trim().length > 0
    && typeof question.context === 'string'
    && question.context.trim().length > 0
    // A figure is deliverable only from the repo-native CC BY Step 1 corpus;
    // rights-managed media is still withheld, since the public lane has no
    // authenticated caller to mint a signed URL for.
    && (question.imageUrl == null || isOpenFigurePath(question.imageUrl))
    && optionDetails(question) !== null;
}

/**
 * Project only media that the authored provenance explicitly permits before
 * grading. After-reveal assets and their captions stay server-side so neither
 * the prompt transport nor client caches can disclose the answer early.
 */
export function cohortPromptMediaForQuestion(
  question: PublicUsmleQuestion,
  now = new Date(),
): Step1SessionMedia | undefined {
  const media = question.publicProvenance.media;
  if (
    media?.kind !== 'asset'
    || media.showWhen !== 'always'
    || typeof question.imageUrl !== 'string'
    || !isOpenFigurePath(question.imageUrl)
    || typeof question.imageCaption !== 'string'
    || question.imageCaption.trim().length === 0
  ) {
    return undefined;
  }

  const asset = publicVisualAssetManifest.assetById.get(media.assetId);
  const expectedRelativePath = question.imageUrl.startsWith(OPEN_STEP1_FIGURE_PREFIX)
    ? `media/${question.imageUrl.slice(OPEN_STEP1_FIGURE_PREFIX.length)}`
    : null;
  const sourcePresentation = asset
    ? step1MediaSourcePresentation(asset.rights.sourcePageUrl)
    : null;
  if (
    !asset
    || !sourcePresentation
    || sourcePresentation.licenseUrl !== asset.rights.licenceUrl
    || expectedRelativePath !== asset.relativePath
    || media.contentHash !== asset.sha256
    || media.licence.id.toLowerCase() !== asset.rights.licenceId.toLowerCase()
    || JSON.stringify(media.clinicalConditionIds ?? null)
      !== JSON.stringify(asset.clinical.conditionIds)
    || JSON.stringify(media.clinicalKeyFindings ?? null)
      !== JSON.stringify(asset.clinical.keyFindings)
    || publicVisualAssetReleaseFailures(asset, {
      target: 'cohort',
      host: 'cohort.md',
      manifestRoot: 'open-content',
      intendedUse: 'prompt',
      today: now.toISOString().slice(0, 10),
    }).length > 0
  ) {
    return undefined;
  }

  const diagnostic = new Set([
    'finding-exemplar',
    'smear',
    'histo',
    'imaging',
    'trace',
  ]).has(media.job);
  const modality: Step1SessionMedia['modality'] = media.job === 'trace'
    ? 'ecg'
    : media.job === 'histo' || media.job === 'smear'
      ? 'histology'
      : media.job === 'imaging'
        ? 'other'
        : undefined;

  return {
    imageUrl: question.imageUrl,
    preAnswerAlt: asset.accessibility.preAnswerAlt,
    class: diagnostic ? 'diagnostic' : 'diagram',
    showWhen: 'always',
    ...(modality ? { modality } : {}),
    attributionText: sourcePresentation.attributionText,
    licenseUrl: asset.rights.licenceUrl,
    ...(sourcePresentation.promptSourcePage ? {
      sourcePageUrl: asset.rights.sourcePageUrl as NonNullable<
        Step1SessionMedia['sourcePageUrl']
      >,
    } : {}),
  };
}

/**
 * Return the diagnosis-bearing accessibility description only after the same
 * current manifest, rights, clinical-binding, and review-date checks used for
 * Cohort prompt delivery pass. This value must never enter a session item.
 */
export function cohortPostAnswerAltForQuestion(
  question: PublicUsmleQuestion,
  now = new Date(),
): string | null {
  const media = question.publicProvenance.media;
  if (
    media?.kind !== 'asset'
    || media.showWhen !== 'always'
    || !cohortPromptMediaForQuestion(question, now)
  ) {
    return null;
  }
  return publicVisualAssetManifest.assetById.get(media.assetId)
    ?.accessibility.postAnswerAlt ?? null;
}

/** Return the exact reviewed manifest source only through the graded reveal. */
export function cohortPostAnswerSourcePageUrlForQuestion(
  question: PublicUsmleQuestion,
  now = new Date(),
): NonNullable<Step1SessionMedia['sourcePageUrl']> | null {
  const media = question.publicProvenance.media;
  if (
    media?.kind !== 'asset'
    || media.showWhen !== 'always'
    || !cohortPromptMediaForQuestion(question, now)
  ) {
    return null;
  }
  const sourcePageUrl = publicVisualAssetManifest.assetById.get(media.assetId)
    ?.rights.sourcePageUrl;
  return sourcePageUrl
    ? sourcePageUrl as NonNullable<Step1SessionMedia['sourcePageUrl']>
    : null;
}

/**
 * Domain identity is a cross-list node, not the primary rotation. Open content
 * uses `usmle/step1/<domain>`; rotation is retained only as a legacy fallback.
 */
export function step1QuestionDomain(question: PublicUsmleQuestion): string {
  const domainNode = [...question.moduleNodes]
    .filter((node) => /^usmle\/step1\/[^/]+$/.test(node))
    .sort()[0];
  if (domainNode) return domainNode;

  const legacyNode = [...question.moduleNodes]
    .filter((node) => /^usmle\/[^/]+$/.test(node) && node !== 'usmle/step1')
    .sort()[0];
  return legacyNode ?? question.rotation;
}

function canonicalHashValue(question: PublicUsmleQuestion) {
  return {
    id: question.id,
    stem: question.stem,
    options: optionDetails(question),
    context: question.context,
    attribution: question.publicProvenance.itemText,
    citation: question.resolvedCitation,
  };
}

/** Detect edits between delivery and grading so a shuffle map is never reused on changed content. */
export function computeStep1QuestionContentHash(question: PublicUsmleQuestion): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalHashValue(question)))
    .digest('hex');
}

function latestHistoryByQuestion(history: Step1HistoryRow[]): Map<string, Step1HistoryRow> {
  const latest = new Map<string, Step1HistoryRow>();
  for (const response of history) {
    const current = latest.get(response.questionId);
    if (!current || current.createdAt.getTime() < response.createdAt.getTime()) {
      latest.set(response.questionId, response);
    }
  }
  return latest;
}

function interleaveDomains<T extends { question: PublicUsmleQuestion }>(items: T[]): T[] {
  const byDomain = new Map<string, T[]>();
  for (const item of items) {
    const domain = step1QuestionDomain(item.question);
    const bucket = byDomain.get(domain) ?? [];
    bucket.push(item);
    byDomain.set(domain, bucket);
  }
  const domains = [...byDomain.keys()].sort();
  const result: T[] = [];
  let offset = 0;
  while (true) {
    let added = false;
    for (const domain of domains) {
      const item = byDomain.get(domain)?.[offset];
      if (!item) continue;
      result.push(item);
      added = true;
    }
    if (!added) return result;
    offset++;
  }
}

function suppressionKey(question: PublicUsmleQuestion): string | null {
  return questionSuppressionKey({
    variantGroupId: question.variantGroupId,
    variantType: question.variantType,
  });
}

function takeWithSemanticSuppression(items: RankedQuestion[], size: number): RankedQuestion[] {
  const selected: RankedQuestion[] = [];
  const families = new Set<string>();
  for (const item of items) {
    const key = suppressionKey(item.question);
    if (key && families.has(key)) continue;
    if (key) families.add(key);
    selected.push(item);
    if (selected.length >= size) break;
  }
  return selected;
}

function effectivePoolSize(questions: PublicUsmleQuestion[]): number {
  return takeWithSemanticSuppression(
    questions
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((question) => ({ question, reason: 'baseline-unseen' as const })),
    Number.MAX_SAFE_INTEGER,
  ).length;
}


/**
 * Order unseen questions by the adaptive ladder rather than by id.
 *
 * cohort.md/tech promises: get it right and the next is harder, get it wrong
 * and it steps down until you can. Ranking by id ignored the outcome entirely,
 * so a doctor and a first-year received the same sequence. Domain interleaving
 * still runs afterwards — it reorders ACROSS domains while preserving order
 * within each, so the difficulty gradient survives the spread.
 */
function adaptiveUnseenOrder(
  unseen: PublicUsmleQuestion[],
  eligibleQuestions: PublicUsmleQuestion[],
  history: Step1HistoryRow[],
  preferredTopicTags: ReadonlySet<string> | null,
): PublicUsmleQuestion[] {
  if (unseen.length <= 1) return unseen;
  const unseenById = new Map(unseen.map((question) => [question.id, question]));
  // rankAdaptive needs the metadata of answered questions to derive the latest
  // tier, promotion streak, domain, and ladder. Those questions are absent from
  // `unseen` by definition, so project the complete eligible ranking pool and
  // filter back to unseen candidates only after ranking.
  const projected = eligibleQuestions.map((question) => ({
    id: question.id,
    difficulty: question.difficulty,
    domain: step1QuestionDomain(question),
    // Exact structured tags only. This is a final tie-break after adaptive tier
    // and missed-concept ladder/domain, never a filter or stem-text heuristic.
    preferenceRank: preferredTopicTags === null
      || (question.topics ?? []).some((topic) =>
        preferredTopicTags.has(topic.trim().toLowerCase()))
      ? 0
      : 1,
    // The strongest scaffolding signal in the corpus: 43 ladders already carry
    // easy/medium/hard rungs of one concept. Missing the hard rung should hand
    // back that ladder's own easier rung, not merely a same-domain question.
    // Read from the topic mirror, not the field. `ladderId` is dropped by the
    // public serving projection, and adding it there would change the release
    // fingerprint bound to every delivery. All 126 ladder questions carry
    // `ladder:<id>` in topics, which serving already keeps.
    ladderId: (question.topics ?? [])
      .find((topic) => typeof topic === 'string' && topic.startsWith('ladder:'))
      ?.slice('ladder:'.length),
  }));
  const ordered = rankAdaptive(projected, history, projected.length);
  return ordered
    .map((item) => unseenById.get(item.id))
    .filter(Boolean) as PublicUsmleQuestion[];
}

function rankBaseline(
  questions: PublicUsmleQuestion[],
  history: Step1HistoryRow[],
  size: number,
): RankedQuestion[] {
  const answered = new Set(history.map((row) => row.questionId));
  const unseen = adaptiveUnseenOrder(
    questions.filter((question) => !answered.has(question.id)),
    questions,
    history,
    null,
  ).map((question) => ({ question, reason: 'baseline-unseen' as const }));
  return takeWithSemanticSuppression(interleaveDomains(unseen), size);
}

function rankDaily(
  questions: PublicUsmleQuestion[],
  history: Step1HistoryRow[],
  size: number,
  now: Date,
  preferAdaptiveUnseen: boolean,
  preferredTopicTags: ReadonlySet<string> | null,
): RankedQuestion[] {
  const latest = latestHistoryByQuestion(history);
  const staleBefore = now.getTime() - STALE_AFTER_MS;

  const review = questions
    .filter((question) => {
      const response = latest.get(question.id);
      return !!response && (!response.isCorrect || response.createdAt.getTime() <= staleBefore);
    })
    .sort((a, b) => {
      const responseA = latest.get(a.id)!;
      const responseB = latest.get(b.id)!;
      if (responseA.isCorrect !== responseB.isCorrect) return responseA.isCorrect ? 1 : -1;
      return responseA.createdAt.getTime() - responseB.createdAt.getTime()
        || a.id.localeCompare(b.id);
    })
    .map((question) => ({ question, reason: 'daily-missed-or-stale' as const }));

  const unseen = adaptiveUnseenOrder(
    questions.filter((question) => !latest.has(question.id)),
    questions,
    history,
    preferredTopicTags,
  ).map((question) => ({ question, reason: 'daily-unseen' as const }));

  const reinforcement = questions
    .filter((question) => {
      const response = latest.get(question.id);
      return !!response && response.isCorrect && response.createdAt.getTime() > staleBefore;
    })
    .sort((a, b) => latest.get(a.id)!.createdAt.getTime() - latest.get(b.id)!.createdAt.getTime())
    .map((question) => ({ question, reason: 'daily-reinforcement' as const }));

  const reviewSpread = interleaveDomains(review);
  // Preserve the adaptive winner across domains for the Cohort one-card head;
  // domain interleaving is intentionally applied only to the remaining pool.
  const latestAttempt = history.length > 0
    ? history.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    : null;
  // Teaching gets one immediate turn after a miss. With no review debt, retain
  // the strongest unseen head so an exact structured-topic preference survives
  // cross-domain interleaving. Once that scaffold has been answered, any
  // ordinary review debt regains priority; otherwise an always-present unseen
  // head would starve missed/stale items until the corpus was exhausted.
  const adaptiveHead = preferAdaptiveUnseen
    && (latestAttempt?.isCorrect === false || reviewSpread.length === 0)
    ? unseen[0]
    : undefined;
  const unseenSpread = interleaveDomains(adaptiveHead ? unseen.slice(1) : unseen);
  const mixed: RankedQuestion[] = [];
  // Public Cohort turns contain one item so the grade can shape the very next
  // request. Put only the strongest adaptive unseen candidate ahead of replay;
  // retain the established review/unseen alternation for every remaining slot.
  if (adaptiveHead) mixed.push(adaptiveHead);
  const maximum = Math.max(reviewSpread.length, unseenSpread.length);
  for (let index = 0; index < maximum; index++) {
    if (reviewSpread[index]) mixed.push(reviewSpread[index]);
    if (unseenSpread[index]) mixed.push(unseenSpread[index]);
  }
  mixed.push(...interleaveDomains(reinforcement));
  return takeWithSemanticSuppression(mixed, size);
}

function shuffledOptions(
  options: DeliverableOption[],
  random: () => number,
): {
  response: Array<{ label: string; text: string }>;
  displayToOriginal: Record<string, string>;
} {
  const shuffled = [...options];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const roll = random();
    const boundedRoll = Number.isFinite(roll) ? Math.max(0, Math.min(0.999999999, roll)) : 0;
    const swapIndex = Math.floor(boundedRoll * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  const displayToOriginal: Record<string, string> = {};
  const response = shuffled.map((option, index) => {
    const label = DISPLAY_LABELS[index];
    displayToOriginal[label] = option.originalLabel;
    return { label, text: option.text };
  });
  return { response, displayToOriginal };
}

async function loadQuestionHistory(
  userId: string,
  questionIds: string[],
): Promise<Step1HistoryRow[]> {
  if (questionIds.length === 0) return [];
  return prisma.questionResponse.findMany({
    where: { userId, questionId: { in: questionIds } },
    select: {
      questionId: true,
      isCorrect: true,
      createdAt: true,
      sessionType: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function persistDeliveriesStrict(rows: Step1DeliveryRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    const result = await tx.serveDecision.createMany({
      data: rows,
    });
    if (result.count !== rows.length) {
      throw new Error(`ServeDecision batch mismatch: expected ${rows.length}, wrote ${result.count}`);
    }
    return result.count;
  });
}

const defaultSessionDependencies: Step1SessionDependencies = {
  loadCorpus: loadPublicUsmleQuestionCorpus,
  loadHistory: loadQuestionHistory,
  persistDeliveries: persistDeliveriesStrict,
  createId,
  random: Math.random,
};

export type Step1SessionCreateResult = Step1SessionResult & {
  /**
   * Leading positions reserved for the requested prepend stage. Missing ids are
   * filled from the ranked pool and still count. Not a public contract field.
   */
  hookItemCount: number;
};

export async function createStep1Session(
  input: {
    userId: string;
    mode: Step1SessionMode;
    size: number;
    domains?: string[];
    now?: Date;
    prependQuestionIds?: string[];
    /** Internal fixed-stage attribution; hook remains the safe default. */
    prependQueueReason?: 'hook-v1' | 'same-concept-remediation';
    allowedDifficulties?: DifficultyTier[];
    /** Internal server-authored attribution. Direct Step 1 callers use the default. */
    surface?: Step1DeliverySurface;
    /** Public one-card turns may teach before replay; private/default ordering stays review-first. */
    preferAdaptiveUnseen?: boolean;
    /** Public-only soft preference over exact structured topic tags. */
    adaptiveCandidatePreference?: { topicTags: readonly string[] };
    /** Internal stable journey identity for transaction-owned Cohort turns. */
    sessionId?: string;
    /** Global position within a stable Cohort journey. */
    positionOffset?: number;
    /** Server-authored hard-focus attribution; never accepted from a client. */
    queueReasonOverride?: 'search-focus';
  },
  dependencyOverrides: Partial<Step1SessionDependencies> = {},
): Promise<Step1SessionCreateResult> {
  const dependencies = { ...defaultSessionDependencies, ...dependencyOverrides };
  const now = input.now ?? new Date();
  const loaded = await dependencies.loadCorpus();
  const promptMediaByQuestionId = new Map<string, Step1SessionMedia>();
  let questions = loaded.questions.filter((question) => {
    if (!isDeliverableStep1Question(question)) return false;
    const media = question.publicProvenance.media;
    if (media?.kind !== 'asset' || media.showWhen !== 'always') return true;
    // The reviewed visual manifest is Cohort-only. Direct/private Step 1 keeps
    // its text-safe corpus and never receives a prompt that depends on media.
    if ((input.surface ?? 'usmle-step1') !== 'cohort') return false;
    const promptMedia = cohortPromptMediaForQuestion(question, now);
    if (!promptMedia) return false;
    promptMediaByQuestionId.set(question.id, promptMedia);
    return true;
  });

  const availableDomains = new Set(questions.map(step1QuestionDomain));
  const requestedDomains = [...new Set(input.domains ?? [])];
  if (requestedDomains.some((domain) => !availableDomains.has(domain))) {
    throw new Step1ApiError(400, 'invalid_domains', 'One or more domains are unavailable');
  }
  if (requestedDomains.length > 0) {
    const selectedDomains = new Set(requestedDomains);
    questions = questions.filter((question) => selectedDomains.has(step1QuestionDomain(question)));
  }

  if (questions.length === 0) {
    throw new Step1ApiError(409, 'corpus_not_ready', 'No eligible Step 1 questions are available');
  }

  const byId = new Map(questions.map((question) => [question.id, question]));
  const requestedPrependIds = (input.prependQuestionIds ?? [])
    .slice(0, Math.max(0, input.size));
  const reservedPrependCount = requestedPrependIds.length;
  const prepended: RankedQuestion[] = [];
  for (const questionId of requestedPrependIds) {
    const question = byId.get(questionId);
    if (!question) continue;
    prepended.push({ question, reason: input.prependQueueReason ?? 'hook-v1' });
  }
  const prependedIds = new Set(prepended.map((row) => row.question.id));

  const difficultyAllowed = input.allowedDifficulties && input.allowedDifficulties.length > 0
    ? new Set(input.allowedDifficulties)
    : null;
  const fillSource = questions.filter((question) => {
    if (prependedIds.has(question.id)) return false;
    if (!difficultyAllowed) return true;
    return difficultyAllowed.has(normaliseDifficulty(question.difficulty));
  });

  const baselinePool = fillSource.filter((question) =>
    question.moduleNodes.includes(USMLE_STEP1_BASELINE_MODULE));
  const fillNeeded = Math.max(0, input.size - prepended.length);
  if (input.mode === 'baseline' && fillNeeded > 0 && effectivePoolSize(baselinePool) < fillNeeded) {
    throw new Step1ApiError(
      409,
      'baseline_not_ready',
      'The pinned baseline does not yet contain enough eligible questions',
    );
  }

  const pool = input.mode === 'baseline' ? baselinePool : fillSource;
  const preferredTopicTags = input.adaptiveCandidatePreference
    ? new Set(input.adaptiveCandidatePreference.topicTags
      .map((topic) => topic.trim().toLowerCase())
      .filter(Boolean))
    : null;
  const poolIds = pool.map((question) => question.id);
  const history = (await dependencies.loadHistory(input.userId, poolIds))
    .filter((row) => poolIds.includes(row.questionId));
  const rankedFill = fillNeeded === 0
    ? []
    : input.mode === 'baseline'
      ? rankBaseline(pool, history, fillNeeded)
      : rankDaily(
        pool,
        history,
        fillNeeded,
        now,
        input.preferAdaptiveUnseen === true,
        preferredTopicTags,
      );
  const attributedFill = input.queueReasonOverride
    ? rankedFill.map(({ question }) => ({ question, reason: input.queueReasonOverride! }))
    : rankedFill;
  const ranked = [...prepended, ...attributedFill];

  if (ranked.length === 0) {
    throw new Step1ApiError(409, 'corpus_not_ready', 'No eligible Step 1 questions are available');
  }

  const positionOffset = input.positionOffset ?? 0;
  if (!Number.isSafeInteger(positionOffset) || positionOffset < 0) {
    throw new Step1ApiError(400, 'invalid_position_offset', 'Position offset is invalid');
  }
  const sessionId = input.sessionId ?? dependencies.createId();
  const decisionPath = input.mode === 'baseline'
    ? 'usmle-step1-baseline-v1' as const
    : 'usmle-step1-daily-v1' as const;
  const rows: Step1DeliveryRow[] = [];
  const items: Step1SessionItem[] = [];

  for (let position = 0; position < ranked.length; position++) {
    const { question, reason } = ranked[position];
    const options = optionDetails(question);
    if (!options) {
      throw new Step1ApiError(409, 'corpus_changed', 'The eligible corpus changed during delivery');
    }
    const deliveryId = dependencies.createId();
    const shuffled = shuffledOptions(options, dependencies.random);
    const promptMedia = promptMediaByQuestionId.get(question.id);
    rows.push({
      id: deliveryId,
      userId: input.userId,
      sessionId,
      batchId: sessionId,
      itemType: 'question',
      itemId: question.id,
      rotation: question.rotation,
      week: question.week,
      decidedAt: now,
      exposedAt: now,
      decisionPath,
      deliveryPath: 'live',
      queueReason: reason,
      position: positionOffset + position,
      rankInPool: position,
      poolSize: pool.length,
      difficultyTier: question.difficulty,
      variantGroupId: question.variantGroupId,
      variantType: question.variantType,
      summary: `USMLE Step 1 ${input.mode} delivery ${position + 1} of ${ranked.length}`,
      payload: {
        contract: USMLE_STEP1_DELIVERY_CONTRACT,
        mode: input.mode,
        surface: input.surface ?? 'usmle-step1',
        displayToOriginal: shuffled.displayToOriginal,
        contentHash: computeStep1QuestionContentHash(question),
        servingFingerprint: question.releaseFingerprint,
      },
    });
    items.push({
      deliveryId,
      stem: question.stem,
      options: shuffled.response,
      domain: step1QuestionDomain(question),
      difficulty: question.difficulty,
      questionType: question.questionType,
      attribution: {
        text: question.publicProvenance.itemText.attribution,
        licence: question.publicProvenance.itemText.licence,
      },
      ...(promptMedia ? { media: promptMedia } : {}),
    });
  }

  if (rows.length > 0) {
    try {
      const written = await dependencies.persistDeliveries(rows);
      if (written !== rows.length) {
        throw new Error(`ServeDecision batch mismatch: expected ${rows.length}, wrote ${written}`);
      }
    } catch {
      throw new Step1ApiError(
        503,
        'delivery_persistence_failed',
        'Could not safely record this delivery; please retry',
      );
    }
  }

  return {
    sessionId,
    mode: input.mode,
    requestedSize: input.size,
    deliveredSize: items.length,
    items,
    hookItemCount: Math.min(reservedPrependCount, items.length),
  };
}

export interface Step1StoredDelivery {
  id: string;
  userId: string;
  sessionId: string;
  batchId: string | null;
  itemType: string;
  itemId: string;
  deliveryPath: string | null;
  decisionPath: string | null;
  answeredAt: Date | null;
  isCorrect: boolean | null;
  responseTimeMs: number | null;
  payload: unknown;
}

/** Minimal receipt: content and answer mappings remain in their existing stores. */
export interface Step1SessionReceipt {
  sessionId: string;
  mode: Step1SessionMode;
  requestedSize: number;
  deliveryIds: string[];
}

/** Rebuild a text-safe Step 1 batch only while every frozen delivery is eligible. */
export function replayStep1Session(
  receipt: Step1SessionReceipt,
  deliveries: Array<{ id: string; itemId: string; sessionId: string; payload: unknown }>,
  corpus: PublicUsmleQuestionCorpus,
): Step1SessionResult {
  const byId = new Map(corpus.questions.map(question => [question.id, question]));
  const byDelivery = new Map(deliveries.map(delivery => [delivery.id, delivery]));
  const revoked = () => new Step1ApiError(410, 'delivery_revoked', 'This session is no longer eligible');
  if (deliveries.length !== receipt.deliveryIds.length) throw revoked();
  const items = receipt.deliveryIds.map(deliveryId => {
    const delivery = byDelivery.get(deliveryId);
    const payload = parseDeliveryPayload(delivery?.payload);
    const question = delivery ? byId.get(delivery.itemId) : undefined;
    if (
      !delivery || delivery.sessionId !== receipt.sessionId
      || !payload || payload.surface !== 'usmle-step1' || payload.mode !== receipt.mode
      || !question || !isDeliverableStep1Question(question)
      || computeStep1QuestionContentHash(question) !== payload.contentHash
      || question.releaseFingerprint !== payload.servingFingerprint
      || (question.publicProvenance.media?.kind === 'asset'
        && question.publicProvenance.media.showWhen === 'always')
    ) throw revoked();
    const options = optionDetails(question);
    if (!options || options.length !== Object.keys(payload.displayToOriginal).length) throw revoked();
    return {
      deliveryId,
      stem: question.stem,
      options: Object.entries(payload.displayToOriginal).map(([label, original]) => {
        const option = options.find(candidate => candidate.originalLabel === original);
        if (!option) throw revoked();
        return { label, text: option.text };
      }),
      domain: step1QuestionDomain(question),
      difficulty: question.difficulty,
      questionType: question.questionType,
      attribution: {
        text: question.publicProvenance.itemText.attribution,
        licence: question.publicProvenance.itemText.licence,
      },
    };
  });
  return {
    sessionId: receipt.sessionId,
    mode: receipt.mode,
    requestedSize: receipt.requestedSize,
    deliveredSize: items.length,
    items,
  };
}

type DeliveryFinalization = 'updated' | 'already-matching' | 'conflict';

interface Step1AnswerDependencies {
  findDelivery: (userId: string, deliveryId: string) => Promise<Step1StoredDelivery | null>;
  loadCorpus: () => Promise<PublicUsmleQuestionCorpus>;
  recordAttempt: (input: RecordQuestionAttemptInput) => Promise<RecordQuestionAttemptResult>;
  markDeliveryAnswered: (input: {
    userId: string;
    deliveryId: string;
    itemId: string;
    sessionId: string;
    isCorrect: boolean;
    responseTimeMs: number | null;
    answeredAt: Date;
  }) => Promise<DeliveryFinalization>;
}

async function findStoredDelivery(
  userId: string,
  deliveryId: string,
): Promise<Step1StoredDelivery | null> {
  return prisma.serveDecision.findFirst({
    where: {
      id: deliveryId,
      userId,
      itemType: 'question',
      deliveryPath: 'live',
      decisionPath: { in: ['usmle-step1-baseline-v1', 'usmle-step1-daily-v1'] },
    },
    select: {
      id: true,
      userId: true,
      sessionId: true,
      batchId: true,
      itemType: true,
      itemId: true,
      deliveryPath: true,
      decisionPath: true,
      answeredAt: true,
      isCorrect: true,
      responseTimeMs: true,
      payload: true,
    },
  });
}

async function markStoredDeliveryAnswered(input: {
  userId: string;
  deliveryId: string;
  itemId: string;
  sessionId: string;
  isCorrect: boolean;
  responseTimeMs: number | null;
  answeredAt: Date;
}): Promise<DeliveryFinalization> {
  const scope: Prisma.ServeDecisionWhereInput = {
    id: input.deliveryId,
    userId: input.userId,
    sessionId: input.sessionId,
    itemType: 'question',
    itemId: input.itemId,
    deliveryPath: 'live',
    decisionPath: { in: ['usmle-step1-baseline-v1', 'usmle-step1-daily-v1'] },
  };
  const updated = await prisma.serveDecision.updateMany({
    where: { ...scope, answeredAt: null },
    data: {
      answeredAt: input.answeredAt,
      isCorrect: input.isCorrect,
      responseTimeMs: input.responseTimeMs,
    },
  });
  if (updated.count === 1) return 'updated';

  const current = await prisma.serveDecision.findFirst({
    where: scope,
    select: { answeredAt: true, isCorrect: true, responseTimeMs: true },
  });
  if (
    current?.answeredAt
    && current.isCorrect === input.isCorrect
    && (current.responseTimeMs ?? null) === input.responseTimeMs
  ) {
    return 'already-matching';
  }
  return 'conflict';
}

const defaultAnswerDependencies: Step1AnswerDependencies = {
  findDelivery: findStoredDelivery,
  loadCorpus: loadPublicUsmleQuestionCorpus,
  recordAttempt: recordQuestionAttemptFast,
  markDeliveryAnswered: markStoredDeliveryAnswered,
};

function parseDeliveryPayload(value: unknown): ParsedStep1DeliveryPayload | null {
  if (!isRecord(value)) return null;
  const isLegacy = value.contract === LEGACY_USMLE_STEP1_DELIVERY_CONTRACT;
  if (
    (!isLegacy && value.contract !== USMLE_STEP1_DELIVERY_CONTRACT)
    || (value.mode !== 'baseline' && value.mode !== 'daily')
    || typeof value.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || typeof value.servingFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.servingFingerprint)
    || !isRecord(value.displayToOriginal)
  ) {
    return null;
  }
  const surface = isLegacy
    ? 'usmle-step1'
    : value.surface === 'usmle-step1' || value.surface === 'cohort'
      ? value.surface
      : null;
  if (!surface) return null;
  const entries = Object.entries(value.displayToOriginal)
    .sort(([displayA], [displayB]) => displayA.localeCompare(displayB));
  if (entries.length < 4 || entries.length > DISPLAY_LABELS.length) return null;
  const originals = new Set<string>();
  const displayToOriginal: Record<string, string> = {};
  for (let index = 0; index < entries.length; index++) {
    const [display, original] = entries[index];
    if (!/^[A-Z]$/.test(display) || typeof original !== 'string') return null;
    if (display !== DISPLAY_LABELS[index]) return null;
    const normalizedOriginal = original.trim().toUpperCase();
    if (!/^[A-Z]$/.test(normalizedOriginal) || originals.has(normalizedOriginal)) return null;
    originals.add(normalizedOriginal);
    displayToOriginal[display] = normalizedOriginal;
  }
  return {
    contract: isLegacy
      ? LEGACY_USMLE_STEP1_DELIVERY_CONTRACT
      : USMLE_STEP1_DELIVERY_CONTRACT,
    mode: value.mode,
    surface,
    contentHash: value.contentHash,
    servingFingerprint: value.servingFingerprint,
    displayToOriginal,
  };
}

function answerFailure(
  status: number,
  code: string,
  error: string,
  background?: Step1AnswerBackground,
): Step1AnswerFailure {
  return { ok: false, status, code, error, ...(background ? { background } : {}) };
}

export interface Step1AnswerFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  /** Canonical write committed; safe idempotent roll-forward work still runs. */
  background?: Step1AnswerBackground;
}

export interface Step1AnswerBackground {
  userId: string;
  questionId: string;
  selectedOption: string | null;
  responseTimeMs?: number;
  confidence: number;
  sessionType: string;
  correctDisplayPosition: number;
  selectedDisplayPosition: number | null;
  isCorrect: boolean;
  skipLearningEvent: true;
  sessionId: string;
  batchId: string;
  /** Stable canonical finalization time, reused by exact retries. */
  now: Date;
}

export type Step1AnswerSuccess = {
  ok: true;
  deduped: boolean;
  reveal: Step1AnswerReveal;
  background?: Step1AnswerBackground;
};

export type Step1AnswerResult = Step1AnswerSuccess | Step1AnswerFailure;

export async function answerStep1Delivery(
  input: {
    userId: string;
    deliveryId: string;
    selectedDisplayLabel: string | null;
    responseTimeMs?: number;
    confidence: number;
    /** Server-authored API boundary; never accepted from the answer client. */
    expectedSurface: Step1DeliverySurface;
    now?: Date;
  },
  dependencyOverrides: Partial<Step1AnswerDependencies> = {},
): Promise<Step1AnswerResult> {
  const dependencies = { ...defaultAnswerDependencies, ...dependencyOverrides };
  const policyNow = input.now ?? new Date();
  const delivery = await dependencies.findDelivery(input.userId, input.deliveryId);
  if (
    !delivery
    || delivery.id !== input.deliveryId
    || delivery.userId !== input.userId
    || delivery.itemType !== 'question'
    || delivery.deliveryPath !== 'live'
  ) {
    return answerFailure(404, 'delivery_not_found', 'Delivery not found');
  }

  const payload = parseDeliveryPayload(delivery.payload);
  const expectedDecisionPath = payload?.mode === 'baseline'
    ? 'usmle-step1-baseline-v1'
    : 'usmle-step1-daily-v1';
  if (
    !payload
    || payload.surface !== input.expectedSurface
    || delivery.decisionPath !== expectedDecisionPath
  ) {
    return answerFailure(404, 'delivery_not_found', 'Delivery not found');
  }

  const loaded = await dependencies.loadCorpus();
  let question = loaded.questions.find((candidate) => candidate.id === delivery.itemId);
  if (!question || !isDeliverableStep1Question(question)) {
    return answerFailure(410, 'delivery_revoked', 'This delivery is no longer eligible');
  }
  if (
    input.expectedSurface === 'cohort'
    && question.publicProvenance.media?.kind === 'asset'
    && question.publicProvenance.media.showWhen === 'always'
    && !cohortPromptMediaForQuestion(question, policyNow)
  ) {
    return answerFailure(410, 'delivery_revoked', 'This delivery is no longer eligible');
  }
  if (computeStep1QuestionContentHash(question) !== payload.contentHash) {
    return answerFailure(409, 'delivery_content_changed', 'Question content changed after delivery');
  }
  if (question.releaseFingerprint !== payload.servingFingerprint) {
    return answerFailure(409, 'delivery_content_changed', 'Question content changed after delivery');
  }

  let options = optionDetails(question)!;
  const currentOriginals = new Set(options.map((option) => option.originalLabel));
  const mappedOriginals = Object.values(payload.displayToOriginal);
  if (
    mappedOriginals.length !== currentOriginals.size
    || mappedOriginals.some((label) => !currentOriginals.has(label))
  ) {
    return answerFailure(409, 'delivery_content_changed', 'Question content changed after delivery');
  }

  const selectedDisplayLabel = input.selectedDisplayLabel?.trim().toUpperCase() ?? null;
  if (selectedDisplayLabel && !(selectedDisplayLabel in payload.displayToOriginal)) {
    return answerFailure(400, 'invalid_display_label', 'Selected display label is invalid');
  }
  const selectedOption = selectedDisplayLabel
    ? payload.displayToOriginal[selectedDisplayLabel]
    : null;
  const correctOriginal = options.find((option) => option.isCorrect)!.originalLabel;
  const correctDisplayLabel = Object.entries(payload.displayToOriginal)
    .find(([, original]) => original === correctOriginal)?.[0];
  if (!correctDisplayLabel) {
    return answerFailure(409, 'delivery_content_changed', 'Question content changed after delivery');
  }

  const sessionType = `${payload.surface === 'cohort' ? 'cohort' : 'usmle'}-${payload.mode}-v1`;
  let attempt: RecordQuestionAttemptResult;
  try {
    attempt = await dependencies.recordAttempt({
      userId: input.userId,
      questionId: question.id,
      clientRequestId: input.deliveryId,
      selectedOption,
      responseTimeMs: input.responseTimeMs,
      confidence: input.confidence,
      sessionType,
      correctDisplayPosition: DISPLAY_LABELS.indexOf(correctDisplayLabel),
      selectedDisplayPosition: selectedDisplayLabel
        ? DISPLAY_LABELS.indexOf(selectedDisplayLabel)
        : null,
      clientTimestampFingerprint: null,
      metadata: {
        surface: payload.surface,
        mode: payload.mode,
        deliveryContract: payload.contract,
      },
      sessionId: delivery.sessionId,
      batchId: delivery.batchId ?? delivery.sessionId,
      publicUsmleDeliveryCapability: PUBLIC_USMLE_DELIVERY_WRITE_CAPABILITY,
      publicUsmleExpectedServingFingerprint: payload.servingFingerprint,
      publicUsmleExpectedCorrectOption: correctOriginal,
      publicUsmleExpectedRotation: question.rotation,
      publicUsmleExpectedWeek: question.week,
      publicUsmleExpectedContext: question.context!,
    });
  } catch {
    throw new Step1ApiError(
      503,
      'answer_persistence_failed',
      'Could not record the answer; retry with the same delivery',
    );
  }

  if (!attempt.ok) {
    if (attempt.code === 'question_content_changed') {
      return answerFailure(
        409,
        'delivery_content_changed',
        'Question content changed after delivery',
      );
    }
    if (attempt.status === 409) {
      return answerFailure(
        409,
        'delivery_already_answered',
        'Delivery was already answered differently',
      );
    }
    return answerFailure(attempt.status, 'answer_not_recorded', 'The answer could not be recorded');
  }

  let deduped: boolean;
  let receipt;
  if ('deduped' in attempt) {
    deduped = true;
    receipt = attempt.receipt;
  } else {
    deduped = false;
    receipt = attempt;
  }
  if (!receipt) {
    throw new Step1ApiError(
      503,
      'answer_receipt_unavailable',
      'The answer receipt is unavailable; retry with the same delivery',
    );
  }

  // Finalize the opaque delivery immediately after the canonical receipt is
  // durable. A subsequent rights/content recheck can still withhold the reveal,
  // but must not strand a committed attempt in an unfinalized state.
  const answeredAt = delivery.answeredAt ?? policyNow;
  let finalization: DeliveryFinalization;
  try {
    finalization = await dependencies.markDeliveryAnswered({
      userId: input.userId,
      deliveryId: delivery.id,
      itemId: delivery.itemId,
      sessionId: delivery.sessionId,
      isCorrect: receipt.isCorrect,
      responseTimeMs: input.responseTimeMs ?? null,
      answeredAt,
    });
  } catch {
    throw new Step1ApiError(
      503,
      'answer_finalization_failed',
      'Answer recorded but not finalized; retry with the same delivery',
    );
  }
  if (finalization === 'conflict') {
    return answerFailure(
      409,
      'delivery_already_answered',
      'Delivery was already answered differently',
    );
  }

  const background: Step1AnswerBackground = {
    userId: input.userId,
    questionId: question.id,
    selectedOption,
    responseTimeMs: input.responseTimeMs,
    confidence: input.confidence,
    sessionType,
    correctDisplayPosition: DISPLAY_LABELS.indexOf(correctDisplayLabel),
    selectedDisplayPosition: selectedDisplayLabel
      ? DISPLAY_LABELS.indexOf(selectedDisplayLabel)
      : null,
    isCorrect: receipt.isCorrect,
    skipLearningEvent: true,
    sessionId: delivery.sessionId,
    batchId: delivery.batchId ?? delivery.sessionId,
    now: answeredAt,
  };

  if (receipt.correctOption.trim().toUpperCase() !== correctOriginal) {
    return answerFailure(
      409,
      'delivery_content_changed',
      'Question content changed after delivery',
      background,
    );
  }

  // Close the read/grade race before revealing. The canonical attempt writer
  // performs its own current-row authorization and grading query; resolve the
  // public registry contract once more in case content or rights changed while
  // that durable transaction was running.
  const postGradeCorpus = await dependencies.loadCorpus();
  const postGradeQuestion = postGradeCorpus.questions
    .find((candidate) => candidate.id === delivery.itemId);
  if (!postGradeQuestion || !isDeliverableStep1Question(postGradeQuestion)) {
    return answerFailure(
      410,
      'delivery_revoked',
      'This delivery is no longer eligible',
      background,
    );
  }
  if (
    input.expectedSurface === 'cohort'
    && postGradeQuestion.publicProvenance.media?.kind === 'asset'
    && postGradeQuestion.publicProvenance.media.showWhen === 'always'
    && !cohortPromptMediaForQuestion(postGradeQuestion, policyNow)
  ) {
    return answerFailure(
      410,
      'delivery_revoked',
      'This delivery is no longer eligible',
      background,
    );
  }
  if (
    computeStep1QuestionContentHash(postGradeQuestion) !== payload.contentHash
    || postGradeQuestion.releaseFingerprint !== payload.servingFingerprint
  ) {
    return answerFailure(
      409,
      'delivery_content_changed',
      'Question content changed after delivery',
      background,
    );
  }
  question = postGradeQuestion;
  options = optionDetails(question)!;

  const optionByOriginal = new Map(options.map((option) => [option.originalLabel, option]));
  const optionExplanations = Object.entries(payload.displayToOriginal)
    .sort(([displayA], [displayB]) => displayA.localeCompare(displayB))
    .map(([label, original]) => {
      const option = optionByOriginal.get(original)!;
      return {
        label,
        explanation: option.explanation,
        misconception: option.misconception,
      };
    });
  const reveal: Step1AnswerReveal = {
    deliveryId: delivery.id,
    questionId: question.id,
    selectedDisplayLabel,
    correctDisplayLabel,
    isCorrect: receipt.isCorrect,
    attemptNumber: receipt.attemptNumber,
    explanation: question.context,
    postAnswerAlt: input.expectedSurface === 'cohort'
      ? cohortPostAnswerAltForQuestion(question, policyNow)
      : null,
    postAnswerSourcePageUrl: input.expectedSurface === 'cohort'
      ? cohortPostAnswerSourcePageUrlForQuestion(question, policyNow)
      : null,
    optionExplanations,
    attribution: {
      text: question.publicProvenance.itemText.attribution,
      licence: question.publicProvenance.itemText.licence,
    },
    citation: question.resolvedCitation,
  };

  const result: Step1AnswerSuccess = { ok: true, deduped, reveal };
  // A prior canonical transaction may have committed before strict delivery
  // finalization failed. In that retry case the attempt is deduped, but the
  // post-commit analytics/streak/remediation work was never scheduled. Return
  // the same rebuildable, idempotent payload after every successful
  // finalization so exact retries close that gap without duplicating the
  // immutable LearningEvent (`skipLearningEvent: true`).
  result.background = background;
  return result;
}

interface Step1ProgressDependencies {
  loadCorpus: () => Promise<PublicUsmleQuestionCorpus>;
  loadHistory: (userId: string, questionIds: string[]) => Promise<Step1HistoryRow[]>;
}

const defaultProgressDependencies: Step1ProgressDependencies = {
  loadCorpus: loadPublicUsmleQuestionCorpus,
  loadHistory: loadQuestionHistory,
};

export async function getStep1Progress(
  input: {
    userId: string;
    timezone?: string;
    now?: Date;
    dailyTarget?: number;
  },
  dependencyOverrides: Partial<Step1ProgressDependencies> = {},
): Promise<Step1Progress> {
  const dependencies = { ...defaultProgressDependencies, ...dependencyOverrides };
  const now = input.now ?? new Date();
  const dailyTarget = input.dailyTarget ?? 10;
  const loaded = await dependencies.loadCorpus();
  const questions = loaded.questions.filter((question) => {
    if (!isDeliverableStep1Question(question)) return false;
    const media = question.publicProvenance.media;
    // Progress belongs to the direct Step 1 surface. Keep its denominator in
    // lockstep with createStep1Session, which reserves prompt-dependent visual
    // questions for the reviewed Cohort media lane.
    return media?.kind !== 'asset' || media.showWhen !== 'always';
  });
  const eligibleIds = new Set(questions.map((question) => question.id));
  const history = (await dependencies.loadHistory(input.userId, [...eligibleIds]))
    .filter((response) => eligibleIds.has(response.questionId));
  const latest = latestHistoryByQuestion(history);

  const baselineQuestions = questions.filter((question) =>
    question.moduleNodes.includes(USMLE_STEP1_BASELINE_MODULE));
  const baselineAttempted = baselineQuestions.filter((question) => latest.has(question.id)).length;
  const baselineCorrect = baselineQuestions.filter((question) => latest.get(question.id)?.isCorrect).length;
  const baselineRemaining = Math.max(0, baselineQuestions.length - baselineAttempted);

  const startOfDay = getStudyDayStart(now, input.timezone);
  const recentStart = new Date(now.getTime() - RECENT_ACTIVITY_MS);
  const domains = [...new Set(questions.map(step1QuestionDomain))]
    .sort()
    .map((domain) => {
      const domainQuestions = questions.filter((question) => step1QuestionDomain(question) === domain);
      const attempted = domainQuestions.filter((question) => latest.has(question.id)).length;
      const correct = domainQuestions.filter((question) => latest.get(question.id)?.isCorrect).length;
      return {
        domain,
        eligible: domainQuestions.length,
        attempted,
        correct,
        unseen: domainQuestions.length - attempted,
      };
    });

  const attempted = latest.size;
  const todayAttempts = history.filter((response) => response.createdAt >= startOfDay).length;
  return {
    corpus: { eligible: questions.length },
    baseline: {
      total: baselineQuestions.length,
      attempted: baselineAttempted,
      correct: baselineCorrect,
      remaining: baselineRemaining,
      complete: baselineQuestions.length > 0 && baselineRemaining === 0,
    },
    coverage: {
      attempted,
      unseen: Math.max(0, questions.length - attempted),
    },
    activity: {
      totalAttempts: history.length,
      correctAttempts: history.filter((response) => response.isCorrect).length,
      todayAttempts,
      recent7dAttempts: history.filter((response) => response.createdAt >= recentStart).length,
    },
    domains,
    dailyTarget,
    nextAction: baselineRemaining > 0
      ? 'baseline'
      : todayAttempts < dailyTarget
        ? 'daily'
        : 'done-for-today',
    limitations: [
      'Descriptive coverage only; not an exam score or pass prediction.',
      'Counts include only questions that satisfy the current public corpus contract.',
    ],
  };
}
