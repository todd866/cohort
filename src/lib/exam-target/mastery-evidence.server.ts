import canvasCurriculumTargetJson from '@/lib/generated/canvas-curriculum-target.json';
import {
  currentCanvasCurriculumSourceUnitsForTopic,
  parseCanvasCurriculumTarget,
  type CurrentCanvasCurriculumSourceUnit,
} from '@/lib/curriculum/canvas-curriculum-target';
import { USYD_MD3_2026 } from '@/lib/curriculum/usyd-md3-2026';
import { resolveReviewedMd3TopicAlias } from '@/lib/curriculum/usyd-md3-2026-topic-aliases';
import { resolveReviewedCurriculumItem } from '@/lib/curriculum/usyd-md3-2026-item-dispositions';
import { EXCLUDED_POOL_TOPICS } from '@/lib/study/servable-pool';
import {
  findManyCards,
  ownerPrivateOrSharedCardScope,
} from '@/lib/cards/read-repository.server';
import {
  computeExamTargetMasteryPlan,
  EXAM_TARGET_MASTERY_POLICY_V1,
  type AppliedDistinctionKind,
  type ExamTargetCoreMasteryEvidence,
  type ExamTargetMasteryPlan,
  type ExamTargetMasteryUnit,
} from './mastery';
import type { ExamTargetRotation } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_CANVAS_CURRICULUM_TARGET = parseCanvasCurriculumTarget(
  canvasCurriculumTargetJson,
);

interface MasteryCardRow {
  id: string;
  factId: string | null;
  rotation: string;
  week: number | null;
  topics: string[];
  conceptId: string | null;
  variantGroupId: string | null;
}

interface MasteryQuestionRow {
  id: string;
  rotation: string;
  week: number | null;
  topics: string[];
  questionType: string;
  format: string | null;
  requiredFacts: Array<{ factId: string }>;
}

interface MasteryFactRow {
  id: string;
  rotation: string;
  topics: string[];
  verified: boolean;
  flagged: boolean;
  concepts: Array<{ conceptId: string }>;
}

interface MasteryLearningEventRow {
  id: string;
  sourceType: string;
  sourceId: string;
  quality: number | null;
  isCorrect: boolean | null;
  timestamp: Date;
}

interface MasteryCardProgressRow {
  cardId: string;
  totalReviews: number;
  correctCount: number;
  retrievalStrength: number;
  stabilityDays: number;
  lastReview: Date | null;
}

interface MasteryConceptStateRow {
  conceptId: string;
  recallOnExamDay: number;
  confidence: number;
}

export interface MasteryEvidenceRepositoryClient {
  card: {
    findMany(args: unknown): Promise<MasteryCardRow[]>;
  };
  question: {
    findMany(args: unknown): Promise<MasteryQuestionRow[]>;
  };
  fact: {
    findMany(args: unknown): Promise<MasteryFactRow[]>;
  };
  learningEvent: {
    findMany(args: unknown): Promise<MasteryLearningEventRow[]>;
  };
  cardProgress: {
    findMany(args: unknown): Promise<MasteryCardProgressRow[]>;
  };
  conceptState: {
    findMany(args: unknown): Promise<MasteryConceptStateRow[]>;
  };
}

export interface LoadExamTargetMasteryEvidenceInput {
  client: MasteryEvidenceRepositoryClient;
  /** Server-owned learner identity; never returned. */
  userId: string;
  /** Already-authorized current exam target. */
  rotation: ExamTargetRotation;
  currentTeachingWeek: number;
  /** Already-authorized candidate identities. This loader cannot widen them. */
  candidateCardIds: readonly string[];
  candidateQuestionIds: readonly string[];
  candidateConceptIds: readonly string[];
  todayRequiredCoreComplete?: boolean | null;
  /** The learner's resolved exam date; absent or invalid remains fail-closed. */
  examDate?: Date | null;
  now?: Date;
  /** User-local day boundary expressed as an instant. Defaults to UTC midnight. */
  todayStart?: Date;
}

export type MasteryEvidenceLoadWarning =
  | 'card-metadata-unavailable'
  | 'target-card-ledger-unavailable'
  | 'question-metadata-unavailable'
  | 'fact-metadata-unavailable'
  | 'learning-events-unavailable'
  | 'card-progress-unavailable'
  | 'concept-states-unavailable'
  | 'card-metadata-incomplete'
  | 'question-metadata-incomplete'
  | 'fact-metadata-incomplete';

export type MasteryUnitMetadataKind =
  | 'scheduled-fact'
  | 'scheduled-card'
  | 'applied-question'
  | 'breadth-card'
  | 'breadth-question'
  | 'coverage-debt';

export type MasteryCoverageDebtReason =
  | 'target-card-ledger-unavailable'
  | 'missing-card-metadata'
  | 'missing-question-metadata'
  | 'missing-card-fact-link'
  | 'missing-question-fact-links'
  | 'missing-fact-metadata';

export interface SafeMasteryUnitMetadata {
  kind: MasteryUnitMetadataKind;
  /** Identities already present in the authorized input; never an entitlement. */
  candidateItemKeys: string[];
  curriculumWeek: number | null;
  /** Canonical curriculum topic IDs only, never arbitrary source text. */
  curriculumTopicIds: string[];
  /** Sanitized current Canvas source-unit IDs; titles and source paths are absent. */
  lectureIds: string[];
  /** Stable ordinals only; key-learning text is deliberately absent. */
  keyLearningIds: string[];
  coverageDebtReason?: MasteryCoverageDebtReason;
}

export type LoadedExamTargetMasteryUnit = ExamTargetMasteryUnit & {
  safeMetadata: SafeMasteryUnitMetadata;
};

export interface SafeMasteryItemStageAssignment {
  unitId: string;
  stage: ExamTargetMasteryUnit['stage'];
}

export interface LoadedExamTargetMasteryEvidence {
  units: LoadedExamTargetMasteryUnit[];
  /** Reverse index over authorized, servable candidates only; never an entitlement. */
  itemStageMap: Record<string, SafeMasteryItemStageAssignment>;
  masteryPlan: ExamTargetMasteryPlan;
  remainingTargetWork: number;
  /** Scheduled-core work attempted successfully today, once per atomic unit. */
  completedCoreWorkToday: number;
  /** Durable scheduled-core units with a corroborated successful retrieval today. */
  completedDurableCoreToday: number;
  /** Reviewed curriculum Facts that currently have no owner-accessible teaching item. */
  curriculumCoverageDebt: Array<{
    factId: string;
    reason: 'no-accessible-teaching-item';
  }>;
  loadWarnings: MasteryEvidenceLoadWarning[];
}

interface LoadResult<T> {
  rows: T[];
  unavailable: boolean;
}

interface CurriculumTopicMetadata {
  topicId: string;
  blockOrder: number;
  curriculumWeek: number | null;
  sourceUnits: CurrentCanvasCurriculumSourceUnit[];
}

interface CurriculumContext {
  rotation: ExamTargetRotation;
  topicByNormalizedId: Map<string, CurriculumTopicMetadata>;
  hasWeeklyStructure: boolean;
  weekKnown: boolean;
  currentTeachingWeek: number;
}

interface UnitWithSortKey {
  unit: LoadedExamTargetMasteryUnit;
  stageOrder: number;
  curriculumOrder: number;
}

interface FallbackCardGroup {
  unitId: string;
  cards: MasteryCardRow[];
}

interface ScheduledCurriculumMatch {
  matchedTopics: CurriculumTopicMetadata[];
  sourceUnitIds: string[];
}

function uniqueSortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))]
    .sort((left, right) => left.localeCompare(right));
}

async function safeLoad<T>(promise: Promise<T[]>): Promise<LoadResult<T>> {
  try {
    return { rows: await promise, unavailable: false };
  } catch {
    return { rows: [], unavailable: true };
  }
}

function normalizeTopic(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildCurriculumContext(
  rotation: ExamTargetRotation,
  currentTeachingWeek: number,
): CurriculumContext {
  const block = USYD_MD3_2026.blocks.find((candidate) => candidate.id === rotation);
  const weekDefinitions = USYD_MD3_2026.weeks
    .filter((week) => week.block === rotation)
    .sort((left, right) => left.number - right.number);
  const topicWeek = new Map<string, number>();
  for (const week of weekDefinitions) {
    for (const topic of week.topics) {
      const normalized = normalizeTopic(topic);
      const existing = topicWeek.get(normalized);
      if (existing === undefined || week.number < existing) {
        topicWeek.set(normalized, week.number);
      }
    }
  }

  const topicByNormalizedId = new Map<string, CurriculumTopicMetadata>();
  for (const [blockOrder, topicId] of (block?.topics ?? []).entries()) {
    topicByNormalizedId.set(normalizeTopic(topicId), {
      topicId,
      blockOrder,
      curriculumWeek: topicWeek.get(normalizeTopic(topicId)) ?? null,
      sourceUnits: currentCanvasCurriculumSourceUnitsForTopic(
        CURRENT_CANVAS_CURRICULUM_TARGET,
        rotation,
        topicId,
      ),
    });
  }

  const weekKnown = Number.isFinite(currentTeachingWeek) && currentTeachingWeek > 0;
  return {
    rotation,
    topicByNormalizedId,
    hasWeeklyStructure: weekDefinitions.length > 0,
    weekKnown,
    currentTeachingWeek: weekKnown ? Math.floor(currentTeachingWeek) : 0,
  };
}

function curriculumMetadataForTopics(
  topics: readonly string[],
  context: CurriculumContext,
): CurriculumTopicMetadata[] {
  const matched = new Map<string, CurriculumTopicMetadata>();
  for (const topic of topics) {
    const normalizedTopic = normalizeTopic(topic);
    const reviewedAlias = resolveReviewedMd3TopicAlias(context.rotation, topic);
    const metadata = context.topicByNormalizedId.get(normalizedTopic)
      ?? (reviewedAlias
        ? context.topicByNormalizedId.get(normalizeTopic(reviewedAlias))
        : undefined);
    if (metadata) matched.set(metadata.topicId, metadata);
  }
  return [...matched.values()].sort(
    (left, right) => left.blockOrder - right.blockOrder
      || left.topicId.localeCompare(right.topicId),
  );
}

function scheduledCurriculumMatch(
  topics: readonly string[],
  context: CurriculumContext,
): ScheduledCurriculumMatch | null {
  const matched = curriculumMetadataForTopics(topics, context);
  // Only reviewed curriculum mappings can create learner core work. Unmapped
  // target content remains available as breadth and is an operator coverage gap.
  if (matched.length === 0) return null;
  const curriculumTopicsAreScheduled = !context.weekKnown || !context.hasWeeklyStructure
    || matched.every(
    (topic) => topic.curriculumWeek === null
      || topic.curriculumWeek <= context.currentTeachingWeek,
  );
  if (!curriculumTopicsAreScheduled) return null;

  const eligibleSourceUnits = matched.map((topic) => topic.sourceUnits.filter((source) => (
    !context.weekKnown
    || !context.hasWeeklyStructure
    || source.teachingWeek === null
    || source.teachingWeek <= context.currentTeachingWeek
  )));
  // Every resolved topic must have current, eligible teaching provenance. This
  // preserves the existing conservative all-topics scheduling rule and keeps a
  // multi-topic item from laundering a source-less or future topic into core.
  if (eligibleSourceUnits.some((sources) => sources.length === 0)) return null;
  return {
    matchedTopics: matched,
    sourceUnitIds: uniqueSortedIds(eligibleSourceUnits.flatMap(sources => (
      sources.map(source => source.sourceUnitId)
    ))),
  };
}

function reviewedItemCurriculumTopics(
  item: Pick<MasteryCardRow | MasteryQuestionRow, 'id' | 'rotation' | 'topics'>,
  inventory: 'card' | 'question',
  context: CurriculumContext,
): CurriculumTopicMetadata[] {
  if (item.rotation !== context.rotation) return [];
  const disposition = resolveReviewedCurriculumItem({
    inventory,
    rotation: context.rotation,
    itemId: item.id,
    sourceFile: null,
    topics: item.topics ?? [],
  });
  if (disposition.reviewedNeutralReason !== null) return [];
  return curriculumMetadataForTopics(disposition.canonicalTopicIds, context);
}

function scheduledFactMatch(
  fact: MasteryFactRow,
  rotation: ExamTargetRotation,
  context: CurriculumContext,
  mappedCardTopics: readonly CurriculumTopicMetadata[] = [],
): ScheduledCurriculumMatch | null {
  if (fact.rotation !== rotation) return null;
  return scheduledCurriculumMatch(uniqueSortedIds([
    ...curriculumMetadataForTopics(fact.topics, context).map(topic => topic.topicId),
    ...mappedCardTopics.map(topic => topic.topicId),
  ]), context);
}

function safeScheduleIdentifiers(
  sourceUnitIds: readonly string[],
): Pick<SafeMasteryUnitMetadata, 'lectureIds' | 'keyLearningIds'> {
  return {
    lectureIds: uniqueSortedIds(sourceUnitIds),
    keyLearningIds: [],
  };
}

function baseSafeMetadata(
  kind: MasteryUnitMetadataKind,
  candidateItemKeys: string[] = [],
): SafeMasteryUnitMetadata {
  return {
    kind,
    candidateItemKeys: uniqueSortedIds(candidateItemKeys),
    curriculumWeek: null,
    curriculumTopicIds: [],
    lectureIds: [],
    keyLearningIds: [],
  };
}

function coverageDebtUnit(
  unitId: string,
  reason: MasteryCoverageDebtReason,
  workMass: number = 1,
): LoadedExamTargetMasteryUnit {
  return {
    unitId,
    stage: 'scheduled-atomic-core',
    evidence: null,
    workMass,
    safeMetadata: {
      ...baseSafeMetadata('coverage-debt'),
      coverageDebtReason: reason,
    },
  };
}

function appliedKindFor(question: MasteryQuestionRow): AppliedDistinctionKind | null {
  const questionType = question.questionType.trim().toLowerCase();
  const format = question.format?.trim().toLowerCase() ?? '';
  if (questionType === 'mechanism' || format === 'mechanism') return 'mechanism';
  if (questionType === 'management' || questionType === 'next-step') return 'management';
  if (
    questionType === 'diagnosis'
    || questionType === 'image-interpretation'
    || format === 'trap'
    || format === 'comparison'
    || format === 'interpretation'
  ) {
    return 'discriminator';
  }
  return null;
}

function safeWholeCount(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : 0;
}

function validTimestamp(value: Date, now: Date): value is Date {
  return value instanceof Date
    && Number.isFinite(value.getTime())
    && value.getTime() <= now.getTime();
}

function fallbackCardUnitId(card: MasteryCardRow): string {
  const variantGroupId = typeof card.variantGroupId === 'string'
    ? card.variantGroupId.trim()
    : '';
  return variantGroupId
    ? `card-variant-group:${variantGroupId}`
    : `card:${card.id}`;
}

function groupFallbackCards(cards: readonly MasteryCardRow[]): FallbackCardGroup[] {
  const grouped = new Map<string, MasteryCardRow[]>();
  for (const card of [...cards].sort((left, right) => left.id.localeCompare(right.id))) {
    const unitId = fallbackCardUnitId(card);
    grouped.set(unitId, [...(grouped.get(unitId) ?? []), card]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unitId, groupedCards]) => ({ unitId, cards: groupedCards }));
}

function acceptedSuccessesByCard(input: {
  events: readonly MasteryLearningEventRow[];
  progress: readonly MasteryCardProgressRow[];
  authorizedCardIds: ReadonlySet<string>;
  now: Date;
}): Map<string, Date[]> {
  const result = new Map<string, Date[]>();

  const eventRows = input.events.filter((event) => (
    validTimestamp(event.timestamp, input.now)
    && event.sourceType === 'card'
    && input.authorizedCardIds.has(event.sourceId)
  ));
  const eventsByItem = new Map<string, MasteryLearningEventRow[]>();
  for (const event of eventRows) {
    const key = `${event.sourceType}:${event.sourceId}`;
    const existing = eventsByItem.get(key) ?? [];
    if (!existing.some((candidate) => candidate.id === event.id)) {
      existing.push(event);
      eventsByItem.set(key, existing);
    }
  }

  const progressByCard = new Map<string, { totalReviews: number; correctCount: number }>();
  for (const row of input.progress) {
    if (!input.authorizedCardIds.has(row.cardId)) continue;
    const totalReviews = safeWholeCount(row.totalReviews);
    const correctCount = Math.min(totalReviews, safeWholeCount(row.correctCount));
    const existing = progressByCard.get(row.cardId);
    progressByCard.set(row.cardId, existing
      ? {
        totalReviews: Math.min(existing.totalReviews, totalReviews),
        correctCount: Math.min(existing.correctCount, correctCount),
      }
      : { totalReviews, correctCount });
  }

  for (const cardId of [...input.authorizedCardIds].sort()) {
    const successes = (eventsByItem.get(`card:${cardId}`) ?? [])
      .filter((event) => typeof event.quality === 'number' && event.quality >= 3)
      .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime()
        || left.id.localeCompare(right.id));
    const corroboratedCount = Math.min(
      successes.length,
      progressByCard.get(cardId)?.correctCount ?? 0,
    );
    if (corroboratedCount > 0) {
      result.set(
        cardId,
        successes.slice(0, corroboratedCount)
          .map((event) => event.timestamp)
          .sort((left, right) => left.getTime() - right.getTime()),
      );
    }
  }

  return result;
}

function acceptedSuccessesByFact(input: {
  cards: readonly MasteryCardRow[];
  successesByCard: ReadonlyMap<string, readonly Date[]>;
  knownFactIds: ReadonlySet<string>;
}): Map<string, Date[]> {
  const result = new Map<string, Date[]>();
  for (const card of input.cards) {
    if (!card.factId || !input.knownFactIds.has(card.factId)) continue;
    const timestamps = input.successesByCard.get(card.id) ?? [];
    if (timestamps.length === 0) continue;
    result.set(card.factId, [
      ...(result.get(card.factId) ?? []),
      ...timestamps,
    ]);
  }
  for (const [factId, timestamps] of result) {
    result.set(factId, [...timestamps].sort((left, right) => left.getTime() - right.getTime()));
  }
  return result;
}

function retrievalSpanDays(
  timestamps: readonly Date[],
  studyDayAnchor: Date,
): number {
  if (timestamps.length < 2) return 0;
  return Math.floor(
    (timestamps[timestamps.length - 1].getTime() - studyDayAnchor.getTime()) / DAY_MS,
  ) - Math.floor(
    (timestamps[0].getTime() - studyDayAnchor.getTime()) / DAY_MS,
  );
}

function conservativeStateForFact(input: {
  fact: MasteryFactRow;
  authorizedConceptIds: ReadonlySet<string>;
  stateRows: readonly MasteryConceptStateRow[];
}): Pick<ExamTargetCoreMasteryEvidence, 'conservativeExamDayRecall' | 'confidence'> {
  const conceptIds = uniqueSortedIds(input.fact.concepts.map((link) => link.conceptId));
  if (
    conceptIds.length === 0
    || conceptIds.some((conceptId) => !input.authorizedConceptIds.has(conceptId))
  ) {
    return { conservativeExamDayRecall: null, confidence: null };
  }

  const statesByConcept = new Map<string, MasteryConceptStateRow[]>();
  for (const row of input.stateRows) {
    if (!input.authorizedConceptIds.has(row.conceptId)) continue;
    statesByConcept.set(row.conceptId, [
      ...(statesByConcept.get(row.conceptId) ?? []),
      row,
    ]);
  }

  const recall: number[] = [];
  const confidence: number[] = [];
  for (const conceptId of conceptIds) {
    const rows = statesByConcept.get(conceptId) ?? [];
    if (rows.length === 0) {
      return { conservativeExamDayRecall: null, confidence: null };
    }
    for (const row of rows) {
      if (
        !Number.isFinite(row.recallOnExamDay)
        || row.recallOnExamDay < 0
        || row.recallOnExamDay > 1
        || !Number.isFinite(row.confidence)
        || row.confidence < 0
        || row.confidence > 1
      ) {
        return { conservativeExamDayRecall: null, confidence: null };
      }
      recall.push(row.recallOnExamDay);
      confidence.push(row.confidence);
    }
  }
  return {
    conservativeExamDayRecall: Math.min(...recall),
    confidence: Math.min(...confidence),
  };
}

function evidenceForFact(input: {
  fact: MasteryFactRow;
  timestamps: readonly Date[];
  studyDayAnchor: Date;
  authorizedConceptIds: ReadonlySet<string>;
  stateRows: readonly MasteryConceptStateRow[];
}): ExamTargetCoreMasteryEvidence {
  const successfulRetrievalCount = input.timestamps.length;
  const successfulRetrievalSpanDays = retrievalSpanDays(
    input.timestamps,
    input.studyDayAnchor,
  );
  return {
    successfulRetrievalCount,
    successfulRetrievalSpanDays,
    ...conservativeStateForFact(input),
  };
}

function evidenceForCardGroup(input: {
  cardIds: readonly string[];
  timestamps: readonly Date[];
  progressRows: readonly MasteryCardProgressRow[];
  studyDayAnchor: Date;
  now: Date;
  examDate: Date | null | undefined;
}): ExamTargetCoreMasteryEvidence {
  const successfulRetrievalCount = input.timestamps.length;
  const validExamDate = input.examDate instanceof Date
    && Number.isFinite(input.examDate.getTime())
    ? input.examDate
    : null;
  const cardIdSet = new Set(input.cardIds);
  const projections = input.progressRows
    .filter((row) => (
      cardIdSet.has(row.cardId)
      && Number.isFinite(row.retrievalStrength)
      && row.retrievalStrength >= 0
      && row.retrievalStrength <= 1
      && Number.isFinite(row.stabilityDays)
      && row.stabilityDays > 0
      && row.lastReview instanceof Date
      && validTimestamp(row.lastReview, input.now)
      && validExamDate !== null
    ))
    .map((row) => {
      const daysToExam = Math.max(
        0,
        (validExamDate!.getTime() - row.lastReview!.getTime()) / DAY_MS,
      );
      return row.retrievalStrength * Math.pow(1 + daysToExam / row.stabilityDays, -0.5);
    })
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  const hasTrustworthyProjection = projections.length > 0;
  return {
    successfulRetrievalCount,
    successfulRetrievalSpanDays: retrievalSpanDays(input.timestamps, input.studyDayAnchor),
    conservativeExamDayRecall: hasTrustworthyProjection ? Math.min(...projections) : null,
    confidence: hasTrustworthyProjection
      ? Math.min(
        1,
        successfulRetrievalCount / EXAM_TARGET_MASTERY_POLICY_V1.minimumSuccessfulRetrievals,
      )
      : null,
  };
}

function remainingCoreRetrievalWork(
  evidence: ExamTargetCoreMasteryEvidence,
): number {
  const successfulRetrievals = typeof evidence.successfulRetrievalCount === 'number'
    && Number.isFinite(evidence.successfulRetrievalCount)
    && evidence.successfulRetrievalCount >= 0
    ? Math.floor(evidence.successfulRetrievalCount)
    : 0;
  const retrievalDeficit = Math.max(
    0,
    EXAM_TARGET_MASTERY_POLICY_V1.minimumSuccessfulRetrievals - successfulRetrievals,
  );
  const spacingDeficit = typeof evidence.successfulRetrievalSpanDays === 'number'
    && Number.isFinite(evidence.successfulRetrievalSpanDays)
    && evidence.successfulRetrievalSpanDays
      >= EXAM_TARGET_MASTERY_POLICY_V1.minimumRetrievalSpanDays
    ? 0
    : 1;
  const recallDeficit = typeof evidence.conservativeExamDayRecall === 'number'
    && Number.isFinite(evidence.conservativeExamDayRecall)
    && evidence.conservativeExamDayRecall
      >= EXAM_TARGET_MASTERY_POLICY_V1.minimumExamDayRecall
    ? 0
    : 1;
  const confidenceDeficit = typeof evidence.confidence === 'number'
    && Number.isFinite(evidence.confidence)
    && evidence.confidence >= EXAM_TARGET_MASTERY_POLICY_V1.minimumConfidence
    ? 0
    : 1;

  const remaining = Math.max(
    retrievalDeficit,
    spacingDeficit,
    recallDeficit,
    confidenceDeficit,
  );
  return remaining === 0 ? 0 : Math.max(1, remaining);
}

function stageOrder(stage: ExamTargetMasteryUnit['stage']): number {
  if (stage === 'scheduled-atomic-core') return 0;
  if (stage === 'applied-distinction') return 1;
  return 2;
}

function deterministicUnits(units: UnitWithSortKey[]): LoadedExamTargetMasteryUnit[] {
  return units
    .sort((left, right) => left.stageOrder - right.stageOrder
      || left.curriculumOrder - right.curriculumOrder
      || left.unit.unitId.localeCompare(right.unit.unitId))
    .map(({ unit }, curriculumOrder) => ({ ...unit, curriculumOrder }));
}

function buildItemStageMap(
  units: readonly LoadedExamTargetMasteryUnit[],
): Record<string, SafeMasteryItemStageAssignment> {
  const assignments = units.flatMap((unit) => (
    unit.safeMetadata.candidateItemKeys.map((itemKey) => ({
      itemKey,
      unitId: unit.unitId,
      stage: unit.stage,
    }))
  )).sort((left, right) => (
    left.itemKey.localeCompare(right.itemKey)
    || stageOrder(left.stage) - stageOrder(right.stage)
    || left.unitId.localeCompare(right.unitId)
  ));

  const result: Record<string, SafeMasteryItemStageAssignment> = {};
  for (const { itemKey, unitId, stage } of assignments) {
    // Fail-safe duplicate policy: retain the most target-constrained assignment.
    result[itemKey] ??= { unitId, stage };
  }
  return result;
}

function defaultNow(value: Date | undefined): Date {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value
    : new Date();
}

function defaultTodayStart(value: Date | undefined, now: Date): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Loads the complete target-rotation Fact ledger for quota accounting, while
 * keeping every servable item identity restricted to caller-authorized
 * candidates. Every Prisma projection is metadata/state-only; raw content and
 * access policy are deliberately outside this boundary.
 */
export async function loadExamTargetMasteryEvidence(
  input: LoadExamTargetMasteryEvidenceInput,
): Promise<LoadedExamTargetMasteryEvidence> {
  const cardIds = uniqueSortedIds(input.candidateCardIds);
  const questionIds = uniqueSortedIds(input.candidateQuestionIds);
  const conceptIds = uniqueSortedIds(input.candidateConceptIds);

  const candidateCardIdSet = new Set(cardIds);
  const candidateQuestionIdSet = new Set(questionIds);
  const now = defaultNow(input.now);
  const todayStart = defaultTodayStart(input.todayStart, now);
  const loadWarnings: MasteryEvidenceLoadWarning[] = [];
  const [cardLoad, targetCardLoad, questionLoad] = await Promise.all([
    cardIds.length > 0
      ? safeLoad(findManyCards(ownerPrivateOrSharedCardScope(input.userId), {
        where: { id: { in: cardIds } },
        select: {
          id: true,
          factId: true,
          rotation: true,
          week: true,
          topics: true,
          conceptId: true,
          variantGroupId: true,
        },
      }, input.client.card))
      : Promise.resolve({ rows: [], unavailable: false }),
    safeLoad(findManyCards(ownerPrivateOrSharedCardScope(input.userId), {
      where: {
        rotation: input.rotation,
        deletedAt: null,
        shelvedAt: null,
        NOT: { topics: { hasSome: [...EXCLUDED_POOL_TOPICS] } },
        progress: {
          none: {
            userId: input.userId,
            OR: [
              { suppressed: true },
              { flagged: true },
              { status: { in: ['retired'] } },
              { leechSuppressedUntil: { gte: now } },
            ],
          },
        },
      },
      select: {
        id: true,
        factId: true,
        rotation: true,
        week: true,
        topics: true,
        conceptId: true,
        variantGroupId: true,
      },
    }, input.client.card)),
    questionIds.length > 0
      ? safeLoad(input.client.question.findMany({
        where: { id: { in: questionIds } },
        select: {
          id: true,
          rotation: true,
          week: true,
          topics: true,
          questionType: true,
          format: true,
          requiredFacts: {
            where: { isRequired: true },
            select: { factId: true },
          },
        },
      }))
      : Promise.resolve({ rows: [], unavailable: false }),
  ]);
  if (cardLoad.unavailable) loadWarnings.push('card-metadata-unavailable');
  if (targetCardLoad.unavailable) loadWarnings.push('target-card-ledger-unavailable');
  if (questionLoad.unavailable) loadWarnings.push('question-metadata-unavailable');

  const candidateCards = cardLoad.rows.filter((row) => candidateCardIdSet.has(row.id));
  const targetCards = targetCardLoad.rows.filter((row) => row.rotation === input.rotation);
  const cards = [...new Map([
    ...targetCards,
    ...candidateCards,
  ].map((row) => [row.id, row] as const)).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const questions = questionLoad.rows.filter((row) => candidateQuestionIdSet.has(row.id));
  const loadedCardIds = new Set(candidateCards.map((row) => row.id));
  const loadedQuestionIds = new Set(questions.map((row) => row.id));
  const curriculum = buildCurriculumContext(input.rotation, input.currentTeachingWeek);
  // Resolve each authorized/owner-accessible item exactly once. The reviewed
  // disposition ledger is the membership boundary: a linked Fact or variant
  // sibling cannot promote a reviewed-neutral item into Canvas core work.
  const reviewedCardTopicsById = new Map(cards.map((card) => [
    card.id,
    reviewedItemCurriculumTopics(card, 'card', curriculum),
  ] as const));
  const reviewedQuestionTopicsById = new Map(questions.map((question) => [
    question.id,
    reviewedItemCurriculumTopics(question, 'question', curriculum),
  ] as const));
  const mappedCardIds = new Set(
    [...reviewedCardTopicsById.entries()]
      .filter(([, topics]) => topics.length > 0)
      .map(([cardId]) => cardId),
  );
  const mappedQuestionIds = new Set(
    [...reviewedQuestionTopicsById.entries()]
      .filter(([, topics]) => topics.length > 0)
      .map(([questionId]) => questionId),
  );
  const missingCardIds = cardIds.filter((id) => !loadedCardIds.has(id));
  const missingQuestionIds = questionIds.filter((id) => !loadedQuestionIds.has(id));
  if (missingCardIds.length > 0 && !cardLoad.unavailable) {
    loadWarnings.push('card-metadata-incomplete');
  }
  if (missingQuestionIds.length > 0 && !questionLoad.unavailable) {
    loadWarnings.push('question-metadata-incomplete');
  }

  const referencedFactIds = uniqueSortedIds([
    ...cards.flatMap((card) => (
      mappedCardIds.has(card.id) && card.factId ? [card.factId] : []
    )),
    ...questions.filter(question => mappedQuestionIds.has(question.id)).flatMap((question) => (
      question.requiredFacts ?? []
    ).map((link) => link.factId)),
  ]);
  const factLoad = await safeLoad(input.client.fact.findMany({
    where: {
      verified: true,
      flagged: false,
      OR: [
        { rotation: input.rotation },
        ...(referencedFactIds.length > 0
          ? [{ id: { in: referencedFactIds } }]
          : []),
      ],
    },
    select: {
      id: true,
      rotation: true,
      topics: true,
      verified: true,
      flagged: true,
      concepts: { select: { conceptId: true } },
    },
  }));
  if (factLoad.unavailable) loadWarnings.push('fact-metadata-unavailable');

  const referencedFactIdSet = new Set(referencedFactIds);
  const reviewedFacts = factLoad.rows.filter((row) => (
    row.verified === true
    && row.flagged === false
    && (row.rotation === input.rotation || referencedFactIdSet.has(row.id))
  ));

  // Reviewed-neutral Cards are breadth-only and cannot establish or satisfy
  // Canvas core mastery, even when they link to an otherwise mapped Fact.
  const evidenceCards = cards.filter(card => mappedCardIds.has(card.id));
  const evidenceCardIds = evidenceCards.map((card) => card.id);
  const evidenceCardIdSet = new Set(evidenceCardIds);
  const accessibleFactIdSet = new Set(uniqueSortedIds([
    ...targetCards.flatMap((card) => (
      mappedCardIds.has(card.id) && card.factId ? [card.factId] : []
    )),
  ]));
  const curriculumCoverageDebt = reviewedFacts
    .filter((fact) => (
      fact.rotation === input.rotation && !accessibleFactIdSet.has(fact.id)
    ))
    .map((fact) => ({
      factId: fact.id,
      reason: 'no-accessible-teaching-item' as const,
    }))
    .sort((left, right) => left.factId.localeCompare(right.factId));
  const facts = reviewedFacts.filter((fact) => (
    fact.rotation !== input.rotation || accessibleFactIdSet.has(fact.id)
  ));
  const reviewedFactsById = new Map(reviewedFacts.map((row) => [row.id, row]));
  const missingFactIds = referencedFactIds.filter((id) => !reviewedFactsById.has(id));
  const missingFactIdSet = new Set(missingFactIds);
  if (missingFactIds.length > 0 && !factLoad.unavailable) {
    loadWarnings.push('fact-metadata-incomplete');
  }
  const evidenceConceptIds = uniqueSortedIds([
    ...conceptIds,
    ...facts
      .filter((fact) => fact.rotation === input.rotation)
      .flatMap((fact) => fact.concepts.map((link) => link.conceptId)),
  ]);
  const evidenceConceptIdSet = new Set(evidenceConceptIds);

  const [eventLoad, progressLoad, stateLoad] = await Promise.all([
    evidenceCardIds.length > 0
      ? safeLoad(input.client.learningEvent.findMany({
        where: {
          userId: input.userId,
          sourceType: 'card',
          sourceId: { in: evidenceCardIds },
          timestamp: { lte: now },
        },
        select: {
          id: true,
          sourceType: true,
          sourceId: true,
          quality: true,
          isCorrect: true,
          timestamp: true,
        },
      }))
      : Promise.resolve({ rows: [], unavailable: false }),
    evidenceCardIds.length > 0
      ? safeLoad(input.client.cardProgress.findMany({
        where: { userId: input.userId, cardId: { in: evidenceCardIds } },
        select: {
          cardId: true,
          totalReviews: true,
          correctCount: true,
          retrievalStrength: true,
          stabilityDays: true,
          lastReview: true,
        },
      }))
      : Promise.resolve({ rows: [], unavailable: false }),
    evidenceConceptIds.length > 0
      ? safeLoad(input.client.conceptState.findMany({
        where: { userId: input.userId, conceptId: { in: evidenceConceptIds } },
        select: { conceptId: true, recallOnExamDay: true, confidence: true },
      }))
      : Promise.resolve({ rows: [], unavailable: false }),
  ]);
  if (eventLoad.unavailable) loadWarnings.push('learning-events-unavailable');
  if (progressLoad.unavailable) loadWarnings.push('card-progress-unavailable');
  if (stateLoad.unavailable) loadWarnings.push('concept-states-unavailable');
  const actualKnownFactIds = new Set(facts.map((fact) => fact.id));
  const acceptedByCard = acceptedSuccessesByCard({
    events: eventLoad.rows,
    progress: progressLoad.rows,
    authorizedCardIds: evidenceCardIdSet,
    now,
  });
  const acceptedByFact = acceptedSuccessesByFact({
    cards: evidenceCards,
    successesByCard: acceptedByCard,
    knownFactIds: actualKnownFactIds,
  });
  const units: UnitWithSortKey[] = [];
  const mappedCardsByFactId = new Map<string, MasteryCardRow[]>();
  for (const card of cards) {
    if (!card.factId || !mappedCardIds.has(card.id)) continue;
    mappedCardsByFactId.set(card.factId, [
      ...(mappedCardsByFactId.get(card.factId) ?? []),
      card,
    ]);
  }
  const scheduledCoreCardIds = new Set<string>();

  for (const fact of facts) {
    const linkedMappedCards = mappedCardsByFactId.get(fact.id) ?? [];
    const scheduleMatch = scheduledFactMatch(
      fact,
      input.rotation,
      curriculum,
      linkedMappedCards.flatMap(card => reviewedCardTopicsById.get(card.id) ?? []),
    );
    if (!scheduleMatch) continue;
    const matchedTopics = scheduleMatch.matchedTopics;
    const curriculumWeek = matchedTopics
      .map((topic) => topic.curriculumWeek)
      .filter((week): week is number => week !== null)
      .sort((left, right) => left - right)[0] ?? null;
    const scheduleIds = safeScheduleIdentifiers(scheduleMatch.sourceUnitIds);
    const candidateItemKeys = candidateCards
      .filter((card) => card.factId === fact.id && mappedCardIds.has(card.id))
      .map((card) => `card:${card.id}`);
    linkedMappedCards.forEach(card => scheduledCoreCardIds.add(card.id));
    const evidence = evidenceForFact({
      fact,
      timestamps: acceptedByFact.get(fact.id) ?? [],
      studyDayAnchor: todayStart,
      authorizedConceptIds: evidenceConceptIdSet,
      stateRows: stateLoad.rows,
    });
    const unit: LoadedExamTargetMasteryUnit = {
      unitId: `fact:${fact.id}`,
      stage: 'scheduled-atomic-core',
      workMass: remainingCoreRetrievalWork(evidence),
      evidence,
      safeMetadata: {
        ...baseSafeMetadata('scheduled-fact', candidateItemKeys),
        curriculumWeek,
        curriculumTopicIds: matchedTopics.map((topic) => topic.topicId),
        ...scheduleIds,
      },
    };
    units.push({
      unit,
      stageOrder: stageOrder(unit.stage),
      curriculumOrder: matchedTopics[0]?.blockOrder ?? Number.MAX_SAFE_INTEGER - 2,
    });
  }

  const fallbackCards = cards.filter((card) => (
    card.factId === null || missingFactIdSet.has(card.factId)
  ));
  const fallbackCardGroups = groupFallbackCards(
    fallbackCards.filter(card => mappedCardIds.has(card.id)),
  );
  const scheduledFallbackMatchByUnitId = new Map<string, ScheduledCurriculumMatch>();
  for (const group of fallbackCardGroups) {
    if (group.cards.some(card => card.rotation !== input.rotation)) continue;
    const match = scheduledCurriculumMatch(
      uniqueSortedIds(group.cards.flatMap(card => (
        (reviewedCardTopicsById.get(card.id) ?? [])
          .map(topic => topic.topicId)
      ))),
      curriculum,
    );
    if (match) scheduledFallbackMatchByUnitId.set(group.unitId, match);
  }
  const scheduledFallbackGroups = fallbackCardGroups.filter((group) => (
    scheduledFallbackMatchByUnitId.has(group.unitId)
  ));
  const scheduledFallbackFactIds = new Set(uniqueSortedIds(
    scheduledFallbackGroups.flatMap((group) => (
      group.cards.flatMap((card) => card.factId ? [card.factId] : [])
    )),
  ));
  if (targetCardLoad.unavailable) {
    const unit = coverageDebtUnit(
      'coverage-debt:target-card-ledger',
      'target-card-ledger-unavailable',
      Number.MAX_SAFE_INTEGER,
    );
    units.push({ unit, stageOrder: 0, curriculumOrder: Number.MAX_SAFE_INTEGER - 1 });
  }
  for (const factId of missingFactIds) {
    if (scheduledFallbackFactIds.has(factId)) continue;
    const unit = coverageDebtUnit(
      `coverage-debt:fact:${factId}`,
      'missing-fact-metadata',
    );
    units.push({ unit, stageOrder: 0, curriculumOrder: Number.MAX_SAFE_INTEGER - 1 });
  }
  for (const cardId of missingCardIds) {
    const unit = coverageDebtUnit(
      `coverage-debt:card:${cardId}`,
      'missing-card-metadata',
    );
    units.push({ unit, stageOrder: 0, curriculumOrder: Number.MAX_SAFE_INTEGER });
  }
  for (const questionId of missingQuestionIds) {
    const unit = coverageDebtUnit(
      `coverage-debt:question:${questionId}`,
      'missing-question-metadata',
    );
    units.push({ unit, stageOrder: 0, curriculumOrder: Number.MAX_SAFE_INTEGER });
  }
  const acceptedByFallbackUnit = new Map<string, Date[]>();
  for (const group of scheduledFallbackGroups) {
    const scheduleMatch = scheduledFallbackMatchByUnitId.get(group.unitId);
    if (!scheduleMatch) continue;
    const groupCardIds = group.cards.map((card) => card.id);
    const groupTimestamps = group.cards
      .flatMap((card) => acceptedByCard.get(card.id) ?? [])
      .sort((left, right) => left.getTime() - right.getTime());
    acceptedByFallbackUnit.set(group.unitId, groupTimestamps);
    group.cards.forEach(card => scheduledCoreCardIds.add(card.id));
    const matchedTopics = scheduleMatch.matchedTopics;
    const curriculumWeek = matchedTopics
      .map((topic) => topic.curriculumWeek)
      .filter((week): week is number => week !== null)
      .sort((left, right) => left - right)[0] ?? null;
    const evidence = evidenceForCardGroup({
      cardIds: groupCardIds,
      timestamps: groupTimestamps,
      progressRows: progressLoad.rows,
      studyDayAnchor: todayStart,
      now,
      examDate: input.examDate,
    });
    const unit: LoadedExamTargetMasteryUnit = {
      unitId: group.unitId,
      stage: 'scheduled-atomic-core',
      evidence,
      workMass: remainingCoreRetrievalWork(evidence),
      safeMetadata: {
        ...baseSafeMetadata(
          'scheduled-card',
          group.cards
            .filter((card) => candidateCardIdSet.has(card.id))
            .map((card) => `card:${card.id}`),
        ),
        curriculumWeek,
        curriculumTopicIds: matchedTopics.map((topic) => topic.topicId),
        ...safeScheduleIdentifiers(scheduleMatch.sourceUnitIds),
      },
    };
    units.push({
      unit,
      stageOrder: stageOrder(unit.stage),
      curriculumOrder: matchedTopics[0]?.blockOrder ?? Number.MAX_SAFE_INTEGER - 2,
    });
  }
  const coreUnitIds = new Set(
    units
      .filter(({ unit }) => unit.stage === 'scheduled-atomic-core')
      .map(({ unit }) => unit.unitId),
  );
  const fallbackCardUnitIdsByFact = new Map<string, string[]>();
  for (const group of scheduledFallbackGroups) {
    for (const factId of uniqueSortedIds(
      group.cards.flatMap((card) => card.factId ? [card.factId] : []),
    )) {
      fallbackCardUnitIdsByFact.set(factId, uniqueSortedIds([
        ...(fallbackCardUnitIdsByFact.get(factId) ?? []),
        group.unitId,
      ]));
    }
  }
  const coreUnitIdsByTopic = new Map<string, string[]>();
  for (const { unit } of units) {
    if (unit.stage !== 'scheduled-atomic-core') continue;
    for (const topicId of unit.safeMetadata.curriculumTopicIds) {
      coreUnitIdsByTopic.set(topicId, uniqueSortedIds([
        ...(coreUnitIdsByTopic.get(topicId) ?? []),
        unit.unitId,
      ]));
    }
  }
  for (const question of questions) {
    const requiredFactIds = uniqueSortedIds(
      (question.requiredFacts ?? []).map((link) => link.factId),
    );
    const appliedKind = appliedKindFor(question);
    const matchedTopics = reviewedQuestionTopicsById.get(question.id) ?? [];
    const questionScheduleMatch = scheduledCurriculumMatch(
      matchedTopics.map(topic => topic.topicId),
      curriculum,
    );
    const isFutureTargetQuestion = question.rotation === input.rotation
      && curriculum.weekKnown
      && curriculum.hasWeeklyStructure
      && matchedTopics.some((topic) => (
        topic.curriculumWeek !== null
        && topic.curriculumWeek > curriculum.currentTeachingWeek
      ));
    const topicPrerequisiteGroups = matchedTopics.map(
      (topic) => coreUnitIdsByTopic.get(topic.topicId) ?? [],
    );
    const hasCompleteTopicPrerequisites = matchedTopics.length > 0
      && topicPrerequisiteGroups.every((unitIds) => unitIds.length > 0);
    const prerequisiteUnitIds = requiredFactIds.length > 0
      ? uniqueSortedIds(requiredFactIds.flatMap((factId) => {
        const fallbackCardUnitIds = fallbackCardUnitIdsByFact.get(factId) ?? [];
        if (fallbackCardUnitIds.length > 0) return fallbackCardUnitIds;
        const debtId = `coverage-debt:fact:${factId}`;
        return coreUnitIds.has(debtId) ? debtId : `fact:${factId}`;
      }))
      : hasCompleteTopicPrerequisites
        ? uniqueSortedIds(topicPrerequisiteGroups.flat())
        : [];
    if (
      appliedKind
      && questionScheduleMatch
      && !isFutureTargetQuestion
      && prerequisiteUnitIds.length > 0
    ) {
      const unit: LoadedExamTargetMasteryUnit = {
        unitId: `question:${question.id}`,
        stage: 'applied-distinction',
        appliedKind,
        prerequisiteUnitIds,
        safeMetadata: {
          ...baseSafeMetadata('applied-question', [`question:${question.id}`]),
          curriculumTopicIds: matchedTopics.map((topic) => topic.topicId),
          ...safeScheduleIdentifiers(questionScheduleMatch.sourceUnitIds),
        },
      };
      units.push({ unit, stageOrder: 1, curriculumOrder: Number.MAX_SAFE_INTEGER });
    } else {
      const unit: LoadedExamTargetMasteryUnit = {
        unitId: `breadth:question:${question.id}`,
        stage: 'breadth-exploration',
        safeMetadata: {
          ...baseSafeMetadata('breadth-question', [`question:${question.id}`]),
        },
      };
      units.push({ unit, stageOrder: 2, curriculumOrder: Number.MAX_SAFE_INTEGER });
    }
  }

  const breadthFallbackCardGroups = groupFallbackCards(
    fallbackCards.filter(card => !scheduledCoreCardIds.has(card.id)),
  );
  for (const group of breadthFallbackCardGroups) {
    const unit: LoadedExamTargetMasteryUnit = {
      unitId: `breadth:${group.unitId}`,
      stage: 'breadth-exploration',
      safeMetadata: {
        ...baseSafeMetadata(
          'breadth-card',
          group.cards
            .filter((card) => candidateCardIdSet.has(card.id))
            .map((card) => `card:${card.id}`),
        ),
      },
    };
    units.push({ unit, stageOrder: 2, curriculumOrder: Number.MAX_SAFE_INTEGER });
  }

  for (const card of cards) {
    if (!card.factId || missingFactIdSet.has(card.factId)) continue;
    if (scheduledCoreCardIds.has(card.id)) continue;
    const unit: LoadedExamTargetMasteryUnit = {
      unitId: `breadth:card:${card.id}`,
      stage: 'breadth-exploration',
      safeMetadata: {
        ...baseSafeMetadata(
          'breadth-card',
          candidateCardIdSet.has(card.id) ? [`card:${card.id}`] : [],
        ),
      },
    };
    units.push({ unit, stageOrder: 2, curriculumOrder: Number.MAX_SAFE_INTEGER });
  }

  const normalizedUnits = deterministicUnits(units);
  const itemStageMap = buildItemStageMap(normalizedUnits);
  const masteryPlan = computeExamTargetMasteryPlan({
    units: normalizedUnits,
    todayRequiredCoreComplete: input.todayRequiredCoreComplete,
  });
  const durableCore = new Set(masteryPlan.durableCoreUnitIds);
  const completedToday = normalizedUnits.reduce((totals, unit) => {
    if (unit.stage !== 'scheduled-atomic-core') return totals;
    const timestamps = unit.unitId.startsWith('fact:')
      ? acceptedByFact.get(unit.unitId.slice('fact:'.length)) ?? []
      : acceptedByFallbackUnit.get(unit.unitId) ?? [];
    const hasAcceptedSuccessToday = timestamps.some((timestamp) => (
      timestamp.getTime() >= todayStart.getTime()
      && timestamp.getTime() <= now.getTime()
    ));
    if (!hasAcceptedSuccessToday) return totals;
    return {
      core: Math.min(Number.MAX_SAFE_INTEGER, totals.core + 1),
      durable: durableCore.has(unit.unitId)
        ? Math.min(Number.MAX_SAFE_INTEGER, totals.durable + 1)
        : totals.durable,
    };
  }, { core: 0, durable: 0 });

  return {
    units: normalizedUnits,
    itemStageMap,
    masteryPlan,
    remainingTargetWork: masteryPlan.remainingTargetWork,
    completedCoreWorkToday: completedToday.core,
    completedDurableCoreToday: completedToday.durable,
    curriculumCoverageDebt,
    loadWarnings,
  };
}
