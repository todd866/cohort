/**
 * Pure card-memory projection for review-history replay.
 *
 * This module deliberately has no Prisma, clock, environment, or scheduler
 * configuration dependencies. Callers must supply the policy, preference
 * snapshot, and time anchor that make a rebuild reproducible.
 *
 * The one import is another pure module: the quality → target-strength
 * ladder, made continuous so objective evidence can enter on the same axis.
 */

import { targetStrengthFor } from './grade-strength';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

export const MEMORY_PROJECTOR_VERSION = 1 as const;
/** Prisma `Int`/PostgreSQL `integer` upper bound for persisted replay order. */
export const MEMORY_SEQUENCE_MAX = 2_147_483_647 as const;
export type MemoryDisposition = 'applied' | 'history_only' | 'baseline_covered';
export type CardMemoryStatus = 'learning' | 'reviewing' | 'mastered' | 'retired';
export type ProjectionOrigin = 'event_replay' | 'anki_snapshot_baseline';
/** Date objects or complete ISO-8601 timestamps with an explicit UTC offset. */
export type MemoryDateInput = Date | string;

export interface CardMemoryProjection {
  stabilityDays: number;
  nextDueAt: Date;
  lastReview: Date | null;
  lastQuality: number | null;
  totalReviews: number;
  correctCount: number;
  status: CardMemoryStatus;
  consecutiveCorrectFast: number;
  masteredAt: Date | null;
  avgResponseTimeMs: number | null;
  retrievalStrength: number;
  recentFailCount: number;
  recentFailWindowStart: Date | null;
  lastFailedAt: Date | null;
  leechSuppressionCount: number;
  leechSuppressedUntil: Date | null;
}

/**
 * The only CardProgress columns a memory rebuild owns. `satisfies Record<...>`
 * makes adding an interface field without adding it to the persistence boundary
 * a compile-time error.
 */
const MEMORY_PROJECTION_FIELD_SET = {
  stabilityDays: true,
  nextDueAt: true,
  lastReview: true,
  lastQuality: true,
  totalReviews: true,
  correctCount: true,
  status: true,
  consecutiveCorrectFast: true,
  masteredAt: true,
  avgResponseTimeMs: true,
  retrievalStrength: true,
  recentFailCount: true,
  recentFailWindowStart: true,
  lastFailedAt: true,
  leechSuppressionCount: true,
  leechSuppressedUntil: true,
} as const satisfies Record<keyof CardMemoryProjection, true>;

export type MemoryProjectionField = keyof typeof MEMORY_PROJECTION_FIELD_SET;
export const MEMORY_PROJECTION_FIELDS = Object.freeze(
  Object.keys(MEMORY_PROJECTION_FIELD_SET) as MemoryProjectionField[],
);

export interface MemoryProjectionPolicyV1 {
  /** Selects an immutable set of transition rules in this module. */
  version: typeof MEMORY_PROJECTOR_VERSION;
  /**
   * Resolved per-card cap. The caller folds exam timing and core-skill caps
   * into this value before replay so ambient configuration cannot change it.
   */
  maximumStabilityDays: number;
  /** Fixed offset east of UTC used for daily review/failure floors. */
  studyDayBoundaryOffsetMinutes: number;
}

export const COHORT_MEMORY_POLICY_V1: Readonly<MemoryProjectionPolicyV1> = Object.freeze({
  version: MEMORY_PROJECTOR_VERSION,
  maximumStabilityDays: 60,
  studyDayBoundaryOffsetMinutes: 0,
});

export interface MemoryPreferenceSnapshot {
  /** Mirrors the current Cohort preference that shortens successful intervals. */
  liked: boolean;
}

interface ReviewPayload {
  kind: 'review';
  id: string;
  occurredAt: MemoryDateInput;
  quality: number;
  responseTimeMs: number | null;
}

export type ReviewMemoryEvent =
  | (ReviewPayload & {
      memoryDisposition: 'applied';
      memorySequence: number;
    })
  | (ReviewPayload & {
      memoryDisposition: 'history_only';
      memorySequence: null;
    })
  | (ReviewPayload & {
      memoryDisposition: 'baseline_covered';
      memorySequence: null;
      coveredByBaselineId: string;
      externalCollectionId: string;
      externalEventId: string;
    });

export interface AnkiSnapshotBaselineCoverage {
  externalCollectionId: string;
  /** Opaque provider cursor; the custody/import layer decides coverage. */
  throughExternalCursor: string;
}

/**
 * A normalized Cohort checkpoint derived from accepted raw Anki card state.
 * It references rather than replaces the lossless custody snapshot.
 */
export interface AnkiSnapshotBaselineEvent {
  kind: 'anki_snapshot_baseline';
  id: string;
  occurredAt: MemoryDateInput;
  memoryDisposition: 'applied';
  memorySequence: number;
  coverage: AnkiSnapshotBaselineCoverage;
  state: CardMemoryProjection;
}

export type MemoryProjectionEvent = ReviewMemoryEvent | AnkiSnapshotBaselineEvent;

export interface MemoryProjectionCheckpoint {
  projectionVersion: typeof MEMORY_PROJECTOR_VERSION;
  projectionOrigin: ProjectionOrigin;
  projectedThroughEventId: string | null;
  projectedThroughMemorySequence: number | null;
  projectedAt: Date;
}

export interface MemoryProjectionHistorySummary {
  /** Includes applied reviews, baselines, and both excluded dispositions. */
  totalEvents: number;
  appliedReviews: number;
  appliedBaselines: number;
  historyOnlyReviews: number;
  baselineCoveredReviews: number;
  historyOnlyEventIds: string[];
  baselineCoveredEventIds: string[];
}

export interface CardMemoryProjectionResult {
  memory: CardMemoryProjection;
  checkpoint: MemoryProjectionCheckpoint;
  history: MemoryProjectionHistorySummary;
  baselineCoverage: AnkiSnapshotBaselineCoverage | null;
}

export interface StreamingMemoryProjectionHistorySummary {
  totalEvents: number;
  appliedReviews: number;
  appliedBaselines: number;
  historyOnlyReviews: number;
  baselineCoveredReviews: number;
}

declare const streamingProjectorBrand: unique symbol;
/** Opaque bounded-memory cursor; construct it only through the factory. */
export interface StreamingCardMemoryProjector {
  readonly [streamingProjectorBrand]: true;
}

export interface StreamingCardMemoryProjectionResult {
  memory: CardMemoryProjection;
  checkpoint: MemoryProjectionCheckpoint;
  history: StreamingMemoryProjectionHistorySummary;
  baselineCoverage: AnkiSnapshotBaselineCoverage | null;
}

export interface ProjectCardMemoryInput {
  events: readonly MemoryProjectionEvent[];
  card: { complexity: number };
  policy: MemoryProjectionPolicyV1;
  preferences: MemoryPreferenceSnapshot;
  asOf: MemoryDateInput;
}

type NormalizedAppliedEvent =
  | (Omit<Extract<ReviewMemoryEvent, { memoryDisposition: 'applied' }>, 'occurredAt'> & {
      occurredAt: Date;
    })
  | (Omit<AnkiSnapshotBaselineEvent, 'occurredAt' | 'state'> & {
      occurredAt: Date;
      state: CardMemoryProjection;
    });

const V1 = Object.freeze({
  initialStabilityDays: 3,
  minimumStabilityDays: 0.5,
  failureStabilityMultiplier: 0.8,
  dueThreshold: 0.4,
  fastThresholdMs: 3_000,
  responseTimeEmaAlpha: 0.3,
  struggleWindowHours: 24,
  leechMinimumReviews: 5,
  // Exile disabled: hard cards stay learnable. Detection still increments
  // leechSuppressionCount for scaffold/alternative telemetry.
  leechBaseSuppressionHours: 0,
  leechMaximumSuppressionHours: 0,
  likedIntervalMultiplier: 0.7,
  reviewsPerStudyDayBeforeDueFloor: 2,
  masteredIntervalsDays: { 1: 180, 2: 90, 3: 60 } as Readonly<Record<number, number>>,
});

/**
 * Rebuild the enumerated memory fields from an explicit baseline and/or review
 * events. Applied rows are sorted only by memorySequence. Occurrence time is
 * used by transition math and history, never to reorder memory.
 */
export function projectCardMemory(input: ProjectCardMemoryInput): CardMemoryProjectionResult {
  const asOf = validDate(input.asOf, 'asOf');
  validatePolicy(input.policy);
  validateCard(input.card);
  validatePreferences(input.preferences);

  const baselines = input.events.filter(isBaseline);
  if (baselines.length > 1) {
    throw new Error('A memory projection epoch may contain at most one anki_snapshot_baseline');
  }
  const baseline = baselines[0] ?? null;
  if (baseline) validateBaseline(baseline);

  const historyOnlyEventIds: string[] = [];
  const baselineCoveredEventIds: string[] = [];
  const applied: NormalizedAppliedEvent[] = [];
  const seenEventIds = new Set<string>();
  const seenSequences = new Set<number>();
  let appliedReviews = 0;

  for (const event of input.events) {
    const eventId = event.id;
    validateEventId(eventId);
    if (seenEventIds.has(eventId)) throw new Error(`Duplicate memory event id: ${eventId}`);
    seenEventIds.add(eventId);

    if (event.kind === 'review') validateReviewPayload(event);

    if (event.memoryDisposition === 'history_only') {
      if (event.memorySequence !== null) {
        throw new Error(`history_only event ${eventId} must not have a memorySequence`);
      }
      historyOnlyEventIds.push(eventId);
      continue;
    }

    if (event.memoryDisposition === 'baseline_covered') {
      if (event.memorySequence !== null) {
        throw new Error(`baseline_covered event ${eventId} must not have a memorySequence`);
      }
      validateCoveredEvent(event, baseline);
      baselineCoveredEventIds.push(eventId);
      continue;
    }

    validateMemorySequence(event.memorySequence, event.id);
    if (seenSequences.has(event.memorySequence)) {
      throw new Error(`Duplicate memorySequence ${event.memorySequence}`);
    }
    seenSequences.add(event.memorySequence);

    if (event.kind === 'anki_snapshot_baseline') {
      applied.push({
        ...event,
        occurredAt: validDate(event.occurredAt, `event ${event.id} occurredAt`),
        state: cloneAndValidateMemory(event.state, `baseline ${event.id}`),
      });
    } else {
      appliedReviews += 1;
      applied.push({
        ...event,
        occurredAt: validDate(event.occurredAt, `event ${event.id} occurredAt`),
      });
    }
  }

  applied.sort((left, right) => left.memorySequence - right.memorySequence);

  for (let index = 1; index < applied.length; index += 1) {
    if (applied[index].occurredAt.getTime() < applied[index - 1].occurredAt.getTime()) {
      throw new Error(
        `Applied timeline would rewind from ${applied[index - 1].id} to ${applied[index].id}; `
        + 'late observations must be history_only or explicitly resequenced',
      );
    }
  }

  if (baseline) {
    const earlierAppliedReview = applied.find(
      (event) => event.kind === 'review'
        && event.memorySequence < baseline.memorySequence,
    );
    if (earlierAppliedReview) {
      throw new Error(
        `Applied review ${earlierAppliedReview.id} precedes baseline ${baseline.id}; `
        + 'covered history must use baseline_covered',
      );
    }
  }

  let memory = emptyMemory(asOf);
  let projectionOrigin: ProjectionOrigin = 'event_replay';
  let baselineCoverage: AnkiSnapshotBaselineCoverage | null = null;
  let projectedThrough: NormalizedAppliedEvent | null = null;
  const reviewCountsByStudyDay = new Map<number, number>();

  for (const event of applied) {
    if (event.kind === 'anki_snapshot_baseline') {
      memory = cloneMemory(event.state);
      projectionOrigin = 'anki_snapshot_baseline';
      baselineCoverage = { ...event.coverage };
      // The baseline's raw Anki activity already produced its accepted due
      // state. Cohort's per-study-day review floor starts fresh at authority
      // transfer rather than reinterpreting covered Anki reviews.
      reviewCountsByStudyDay.clear();
    } else {
      const studyDayStart = startOfStudyDay(
        event.occurredAt,
        input.policy.studyDayBoundaryOffsetMinutes,
      );
      const reviewsOnStudyDay = (reviewCountsByStudyDay.get(studyDayStart) ?? 0) + 1;
      reviewCountsByStudyDay.set(studyDayStart, reviewsOnStudyDay);
      memory = applyReview(memory, event, {
        complexity: input.card.complexity,
        maximumStabilityDays: input.policy.maximumStabilityDays,
        liked: input.preferences.liked,
        studyDayStart,
        reviewsOnStudyDay,
      });
    }
    projectedThrough = event;
  }

  return {
    memory: cloneMemory(memory),
    checkpoint: {
      projectionVersion: input.policy.version,
      projectionOrigin,
      projectedThroughEventId: projectedThrough?.id ?? null,
      projectedThroughMemorySequence: projectedThrough?.memorySequence ?? null,
      projectedAt: new Date(asOf),
    },
    history: {
      totalEvents: input.events.length,
      appliedReviews,
      appliedBaselines: baseline ? 1 : 0,
      historyOnlyReviews: historyOnlyEventIds.length,
      baselineCoveredReviews: baselineCoveredEventIds.length,
      historyOnlyEventIds: historyOnlyEventIds.sort(),
      baselineCoveredEventIds: baselineCoveredEventIds.sort(),
    },
    baselineCoverage,
  };
}

type StreamingProjectorState = {
  asOf: Date;
  card: { complexity: number };
  policy: MemoryProjectionPolicyV1;
  preferences: MemoryPreferenceSnapshot;
  memory: CardMemoryProjection;
  projectionOrigin: ProjectionOrigin;
  baseline: (Omit<AnkiSnapshotBaselineEvent, 'occurredAt'> & { occurredAt: Date }) | null;
  baselineCoverage: AnkiSnapshotBaselineCoverage | null;
  projectedThroughEventId: string | null;
  projectedThroughMemorySequence: number | null;
  lastAppliedAt: Date | null;
  lastStudyDayStart: number | null;
  reviewsOnStudyDay: number;
  history: StreamingMemoryProjectionHistorySummary;
};

const STREAMING_PROJECTOR_STATES = new WeakMap<object, StreamingProjectorState>();

/**
 * Bounded replay for an already identity-validated cursor (for example rows
 * from a unique `(collectionId, revlogId)` table). Applied events must arrive
 * in strictly increasing memorySequence order. Unlike `projectCardMemory`,
 * this seam intentionally does not retain every event ID merely to rediscover
 * duplicates; the durable source constraint owns identity uniqueness.
 */
export function createStreamingCardMemoryProjector(
  input: Omit<ProjectCardMemoryInput, 'events'>,
): StreamingCardMemoryProjector {
  const asOf = validDate(input.asOf, 'asOf');
  validatePolicy(input.policy);
  validateCard(input.card);
  validatePreferences(input.preferences);
  const cursor = Object.freeze({}) as StreamingCardMemoryProjector;
  STREAMING_PROJECTOR_STATES.set(cursor, {
    asOf,
    card: { ...input.card },
    policy: { ...input.policy },
    preferences: { ...input.preferences },
    memory: emptyMemory(asOf),
    projectionOrigin: 'event_replay',
    baseline: null,
    baselineCoverage: null,
    projectedThroughEventId: null,
    projectedThroughMemorySequence: null,
    lastAppliedAt: null,
    lastStudyDayStart: null,
    reviewsOnStudyDay: 0,
    history: {
      totalEvents: 0,
      appliedReviews: 0,
      appliedBaselines: 0,
      historyOnlyReviews: 0,
      baselineCoveredReviews: 0,
    },
  });
  return cursor;
}

export function appendStreamingCardMemoryEvent(
  cursor: StreamingCardMemoryProjector,
  event: MemoryProjectionEvent,
): void {
  const state = STREAMING_PROJECTOR_STATES.get(cursor);
  if (!state) throw new Error('Unknown streaming memory projector cursor');
  const eventId = event.id;
  validateEventId(eventId);
  state.history.totalEvents += 1;

  if (event.kind === 'review') validateReviewPayload(event);
  if (event.memoryDisposition === 'history_only') {
    if (event.memorySequence !== null) {
      throw new Error(`history_only event ${eventId} must not have a memorySequence`);
    }
    state.history.historyOnlyReviews += 1;
    return;
  }
  if (event.memoryDisposition === 'baseline_covered') {
    if (event.memorySequence !== null) {
      throw new Error(`baseline_covered event ${eventId} must not have a memorySequence`);
    }
    validateCoveredEvent(event, state.baseline);
    state.history.baselineCoveredReviews += 1;
    return;
  }

  validateMemorySequence(event.memorySequence, eventId);
  if (
    state.projectedThroughMemorySequence !== null
    && event.memorySequence <= state.projectedThroughMemorySequence
  ) {
    throw new Error('Streaming memory events must have strictly increasing memorySequence values');
  }
  const occurredAt = validDate(event.occurredAt, `event ${event.id} occurredAt`);
  if (state.lastAppliedAt && occurredAt.getTime() < state.lastAppliedAt.getTime()) {
    throw new Error(
      `Applied timeline would rewind from ${state.projectedThroughEventId} to ${event.id}; `
      + 'late observations must be history_only or explicitly resequenced',
    );
  }

  if (event.kind === 'anki_snapshot_baseline') {
    if (state.baseline) {
      throw new Error('A memory projection epoch may contain at most one anki_snapshot_baseline');
    }
    if (state.history.appliedReviews > 0) {
      throw new Error(`Applied review precedes baseline ${event.id}; covered history must use baseline_covered`);
    }
    validateBaseline(event);
    state.baseline = { ...event, occurredAt };
    state.baselineCoverage = { ...event.coverage };
    state.memory = cloneAndValidateMemory(event.state, `baseline ${event.id}`);
    state.projectionOrigin = 'anki_snapshot_baseline';
    state.lastStudyDayStart = null;
    state.reviewsOnStudyDay = 0;
    state.history.appliedBaselines += 1;
  } else {
    const studyDayStart = startOfStudyDay(
      occurredAt,
      state.policy.studyDayBoundaryOffsetMinutes,
    );
    if (state.lastStudyDayStart === studyDayStart) state.reviewsOnStudyDay += 1;
    else {
      state.lastStudyDayStart = studyDayStart;
      state.reviewsOnStudyDay = 1;
    }
    state.memory = applyReview(state.memory, { ...event, occurredAt }, {
      complexity: state.card.complexity,
      maximumStabilityDays: state.policy.maximumStabilityDays,
      liked: state.preferences.liked,
      studyDayStart,
      reviewsOnStudyDay: state.reviewsOnStudyDay,
    });
    state.history.appliedReviews += 1;
  }
  state.projectedThroughEventId = event.id;
  state.projectedThroughMemorySequence = event.memorySequence;
  state.lastAppliedAt = occurredAt;
}

export function finishStreamingCardMemoryProjection(
  cursor: StreamingCardMemoryProjector,
): StreamingCardMemoryProjectionResult {
  const state = STREAMING_PROJECTOR_STATES.get(cursor);
  if (!state) throw new Error('Unknown streaming memory projector cursor');
  return {
    memory: cloneMemory(state.memory),
    checkpoint: {
      projectionVersion: state.policy.version,
      projectionOrigin: state.projectionOrigin,
      projectedThroughEventId: state.projectedThroughEventId,
      projectedThroughMemorySequence: state.projectedThroughMemorySequence,
      projectedAt: new Date(state.asOf),
    },
    history: { ...state.history },
    baselineCoverage: state.baselineCoverage ? { ...state.baselineCoverage } : null,
  };
}

/**
 * Overlay only event-derived memory fields. User feedback, suppression, flags,
 * view counters, confusion context, and remediation references remain intact.
 */
export function mergeMemoryProjection<T extends object>(
  existing: T,
  memory: CardMemoryProjection,
): Omit<T, MemoryProjectionField> & CardMemoryProjection {
  const merged: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
  const cloned = cloneMemory(memory) as unknown as Record<MemoryProjectionField, unknown>;
  for (const field of MEMORY_PROJECTION_FIELDS) merged[field] = cloned[field];
  return merged as Omit<T, MemoryProjectionField> & CardMemoryProjection;
}

function applyReview(
  current: CardMemoryProjection,
  event: Extract<NormalizedAppliedEvent, { kind: 'review' }>,
  context: {
    complexity: number;
    maximumStabilityDays: number;
    liked: boolean;
    studyDayStart: number;
    reviewsOnStudyDay: number;
  },
): CardMemoryProjection {
  const quality = event.quality;
  const reviewedAt = event.occurredAt;
  const daysSinceLastReview = current.lastReview
    ? (reviewedAt.getTime() - current.lastReview.getTime()) / MS_PER_DAY
    : 0;

  const stabilityDays = updateStability(
    current.stabilityDays,
    quality,
    context.maximumStabilityDays,
  );
  const retrievalStrength = updateRetrieval(
    current.retrievalStrength,
    quality,
    current.totalReviews,
    daysSinceLastReview,
    current.stabilityDays,
  );
  const totalReviews = current.totalReviews + 1;
  const correctCount = current.correctCount + (quality >= 3 ? 1 : 0);
  const mastery = updateMastery(current, {
    quality,
    responseTimeMs: event.responseTimeMs,
    complexity: context.complexity,
    totalReviews,
    retrievalStrength,
    reviewedAt,
  });
  const struggle = updateStruggle(current, quality, reviewedAt);

  let leechSuppressionCount = current.leechSuppressionCount;
  let leechSuppressedUntil = cloneNullableDate(current.leechSuppressedUntil);
  if (quality < 3 && totalReviews >= V1.leechMinimumReviews && correctCount === 0) {
    const suppressionHours = Math.min(
      V1.leechBaseSuppressionHours * Math.pow(2, leechSuppressionCount),
      V1.leechMaximumSuppressionHours,
    );
    leechSuppressionCount += 1;
    // Exile disabled (hours always 0 via struggle.computeLeechSuppressionHours
    // policy mirror). Keep the encounter count; clear any park.
    leechSuppressedUntil = suppressionHours > 0
      ? new Date(reviewedAt.getTime() + suppressionHours * MS_PER_HOUR)
      : null;
  }

  let nextDueAt = mastery.nextDueInDays === null
    ? computeNextDueAt(retrievalStrength, reviewedAt, stabilityDays)
    : new Date(reviewedAt.getTime() + mastery.nextDueInDays * MS_PER_DAY);
  const nextStudyDay = context.studyDayStart + MS_PER_DAY;

  if (
    context.reviewsOnStudyDay >= V1.reviewsPerStudyDayBeforeDueFloor
    && nextDueAt.getTime() < nextStudyDay
  ) {
    nextDueAt = new Date(nextStudyDay);
  }

  if (quality < 3) {
    const failPushbackDays = struggle.recentFailCount >= 3
      ? 3
      : struggle.recentFailCount >= 2
        ? 2
        : 1;
    const failureFloor = context.studyDayStart + failPushbackDays * MS_PER_DAY;
    if (nextDueAt.getTime() < failureFloor) nextDueAt = new Date(failureFloor);
  }

  if (context.liked && quality >= 3) {
    const shortenedInterval = (nextDueAt.getTime() - reviewedAt.getTime())
      * V1.likedIntervalMultiplier;
    nextDueAt = new Date(reviewedAt.getTime() + shortenedInterval);
    if (nextDueAt.getTime() < nextStudyDay) nextDueAt = new Date(nextStudyDay);
  }

  return {
    stabilityDays,
    nextDueAt,
    lastReview: new Date(reviewedAt),
    lastQuality: quality,
    totalReviews,
    correctCount,
    status: mastery.status,
    consecutiveCorrectFast: mastery.consecutiveCorrectFast,
    masteredAt: cloneNullableDate(mastery.masteredAt),
    avgResponseTimeMs: mastery.avgResponseTimeMs,
    retrievalStrength,
    recentFailCount: struggle.recentFailCount,
    recentFailWindowStart: cloneNullableDate(struggle.recentFailWindowStart),
    lastFailedAt: cloneNullableDate(struggle.lastFailedAt),
    leechSuppressionCount,
    leechSuppressedUntil,
  };
}

function updateStability(
  currentStabilityDays: number,
  quality: number,
  maximumStabilityDays: number,
): number {
  const baseline = Number.isFinite(currentStabilityDays) && currentStabilityDays > 0
    ? currentStabilityDays
    : V1.initialStabilityDays;
  if (quality < 3) {
    return Math.max(V1.minimumStabilityDays, baseline * V1.failureStabilityMultiplier);
  }
  const multiplier = 1.4 + 0.1 * Math.max(0, quality - 3);
  return Math.min(maximumStabilityDays, baseline * multiplier);
}

function updateRetrieval(
  storedStrength: number,
  quality: number,
  totalReviews: number,
  daysSinceLastReview: number,
  stabilityDays: number,
): number {
  const decayFactor = daysSinceLastReview <= 0
    ? 1
    : Math.pow(1 + daysSinceLastReview / stabilityDays, -0.5);
  const decayedStrength = storedStrength * decayFactor;
  // Piecewise-linear through the original five rungs (5→1.0, 4→0.9, 3→0.8,
  // 2→0.5, ≤1→0.3); identical at every integer, asserted in grade-strength.test.
  // Continuous so a conditioned grade carrying objective evidence — an MCQ
  // accuracy is a retrieval probability on this same axis — is not rounded
  // into a bucket up to sixteen points away.
  const targetStrength = targetStrengthFor(quality);
  const alpha = totalReviews === 0
    ? 0.9
    : Math.min(0.7, Math.max(0.3, 0.7 / Math.sqrt(Math.max(1, totalReviews))));
  return decayedStrength + (targetStrength - decayedStrength) * alpha;
}

function computeNextDueAt(strength: number, reviewedAt: Date, stabilityDays: number): Date {
  if (!Number.isFinite(strength) || strength <= V1.dueThreshold) return new Date(reviewedAt);
  if (!Number.isFinite(stabilityDays) || stabilityDays <= 0) return new Date(reviewedAt);
  const ratio = strength / V1.dueThreshold;
  const daysUntilDue = stabilityDays * (ratio * ratio - 1);
  if (!Number.isFinite(daysUntilDue) || daysUntilDue <= 0) return new Date(reviewedAt);
  return new Date(reviewedAt.getTime() + daysUntilDue * MS_PER_DAY);
}

function updateMastery(
  current: CardMemoryProjection,
  input: {
    quality: number;
    responseTimeMs: number | null;
    complexity: number;
    totalReviews: number;
    retrievalStrength: number;
    reviewedAt: Date;
  },
): {
  status: CardMemoryStatus;
  consecutiveCorrectFast: number;
  avgResponseTimeMs: number | null;
  masteredAt: Date | null;
  nextDueInDays: number | null;
} {
  const correct = input.quality >= 3;
  const fast = input.responseTimeMs !== null && input.responseTimeMs < V1.fastThresholdMs;
  let consecutiveCorrectFast = current.consecutiveCorrectFast;
  if (correct && fast) consecutiveCorrectFast += 1;
  // Compatibility with updateMasteryState: a slow correct pauses this counter;
  // only a failed recall breaks it. Despite the legacy field name, this is not
  // a strict uninterrupted fast-answer streak in projector version 1.
  else if (!correct) consecutiveCorrectFast = 0;

  let avgResponseTimeMs = current.avgResponseTimeMs;
  if (input.responseTimeMs !== null) {
    avgResponseTimeMs = avgResponseTimeMs === null
      ? input.responseTimeMs
      : Math.round(
          V1.responseTimeEmaAlpha * input.responseTimeMs
          + (1 - V1.responseTimeEmaAlpha) * avgResponseTimeMs,
        );
  }

  const shouldGraduate = input.complexity === 1
    ? consecutiveCorrectFast >= 3
    : input.complexity === 2
      ? input.totalReviews >= 5 && input.retrievalStrength >= 0.8
      : false;

  let status = current.status;
  let masteredAt = cloneNullableDate(current.masteredAt);
  let nextDueInDays: number | null = null;
  if (current.status === 'mastered' && !correct) {
    status = 'reviewing';
    masteredAt = null;
  } else if (shouldGraduate && current.status !== 'mastered' && current.status !== 'retired') {
    status = 'mastered';
    masteredAt = new Date(input.reviewedAt);
    nextDueInDays = V1.masteredIntervalsDays[input.complexity] ?? 90;
  } else if (current.status === 'learning' && correct && input.totalReviews >= 2) {
    status = 'reviewing';
  }

  return {
    status,
    consecutiveCorrectFast,
    avgResponseTimeMs,
    masteredAt,
    nextDueInDays,
  };
}

function updateStruggle(
  current: CardMemoryProjection,
  quality: number,
  reviewedAt: Date,
): Pick<CardMemoryProjection, 'recentFailCount' | 'recentFailWindowStart' | 'lastFailedAt'> {
  if (quality >= 3) {
    return { recentFailCount: 0, recentFailWindowStart: null, lastFailedAt: null };
  }
  if (!current.recentFailWindowStart) {
    return {
      recentFailCount: 1,
      recentFailWindowStart: new Date(reviewedAt),
      lastFailedAt: new Date(reviewedAt),
    };
  }
  const windowAgeHours = (reviewedAt.getTime() - current.recentFailWindowStart.getTime())
    / MS_PER_HOUR;
  if (windowAgeHours > V1.struggleWindowHours) {
    return {
      recentFailCount: 1,
      recentFailWindowStart: new Date(reviewedAt),
      lastFailedAt: new Date(reviewedAt),
    };
  }
  return {
    recentFailCount: current.recentFailCount + 1,
    recentFailWindowStart: new Date(current.recentFailWindowStart),
    lastFailedAt: new Date(reviewedAt),
  };
}

function emptyMemory(asOf: Date): CardMemoryProjection {
  return {
    stabilityDays: V1.initialStabilityDays,
    nextDueAt: new Date(asOf),
    lastReview: null,
    lastQuality: null,
    totalReviews: 0,
    correctCount: 0,
    status: 'learning',
    consecutiveCorrectFast: 0,
    masteredAt: null,
    avgResponseTimeMs: null,
    retrievalStrength: 0,
    recentFailCount: 0,
    recentFailWindowStart: null,
    lastFailedAt: null,
    leechSuppressionCount: 0,
    leechSuppressedUntil: null,
  };
}

function cloneMemory(memory: CardMemoryProjection): CardMemoryProjection {
  return {
    ...memory,
    nextDueAt: new Date(memory.nextDueAt),
    lastReview: cloneNullableDate(memory.lastReview),
    masteredAt: cloneNullableDate(memory.masteredAt),
    recentFailWindowStart: cloneNullableDate(memory.recentFailWindowStart),
    lastFailedAt: cloneNullableDate(memory.lastFailedAt),
    leechSuppressedUntil: cloneNullableDate(memory.leechSuppressedUntil),
  };
}

function cloneAndValidateMemory(memory: CardMemoryProjection, label: string): CardMemoryProjection {
  const cloned: CardMemoryProjection = {
    stabilityDays: finiteNumber(memory.stabilityDays, `${label}.stabilityDays`),
    nextDueAt: validDate(memory.nextDueAt, `${label}.nextDueAt`),
    lastReview: nullableValidDate(memory.lastReview, `${label}.lastReview`),
    lastQuality: memory.lastQuality,
    totalReviews: nonNegativeInteger(memory.totalReviews, `${label}.totalReviews`),
    correctCount: nonNegativeInteger(memory.correctCount, `${label}.correctCount`),
    status: memory.status,
    consecutiveCorrectFast: nonNegativeInteger(
      memory.consecutiveCorrectFast,
      `${label}.consecutiveCorrectFast`,
    ),
    masteredAt: nullableValidDate(memory.masteredAt, `${label}.masteredAt`),
    avgResponseTimeMs: memory.avgResponseTimeMs,
    retrievalStrength: finiteNumber(memory.retrievalStrength, `${label}.retrievalStrength`),
    recentFailCount: nonNegativeInteger(memory.recentFailCount, `${label}.recentFailCount`),
    recentFailWindowStart: nullableValidDate(
      memory.recentFailWindowStart,
      `${label}.recentFailWindowStart`,
    ),
    lastFailedAt: nullableValidDate(memory.lastFailedAt, `${label}.lastFailedAt`),
    leechSuppressionCount: nonNegativeInteger(
      memory.leechSuppressionCount,
      `${label}.leechSuppressionCount`,
    ),
    leechSuppressedUntil: nullableValidDate(
      memory.leechSuppressedUntil,
      `${label}.leechSuppressedUntil`,
    ),
  };

  if (cloned.stabilityDays <= 0) throw new Error(`${label}.stabilityDays must be positive`);
  if (cloned.correctCount > cloned.totalReviews) {
    throw new Error(`${label}.correctCount cannot exceed totalReviews`);
  }
  if (cloned.lastQuality !== null) validateQuality(cloned.lastQuality, `${label}.lastQuality`);
  if (!isCardMemoryStatus(cloned.status)) throw new Error(`${label}.status is invalid`);
  if (
    cloned.avgResponseTimeMs !== null
    && (!Number.isFinite(cloned.avgResponseTimeMs) || cloned.avgResponseTimeMs < 0)
  ) {
    throw new Error(`${label}.avgResponseTimeMs must be null or non-negative`);
  }
  if (cloned.retrievalStrength < 0 || cloned.retrievalStrength > 1) {
    throw new Error(`${label}.retrievalStrength must be between 0 and 1`);
  }
  return cloned;
}

function validatePolicy(policy: MemoryProjectionPolicyV1): void {
  if (policy.version !== MEMORY_PROJECTOR_VERSION) {
    throw new Error(`Unsupported memory projection policy version: ${String(policy.version)}`);
  }
  if (
    !Number.isFinite(policy.maximumStabilityDays)
    || policy.maximumStabilityDays < V1.minimumStabilityDays
  ) {
    throw new Error('maximumStabilityDays must be a finite number >= 0.5');
  }
  if (
    !Number.isSafeInteger(policy.studyDayBoundaryOffsetMinutes)
    || Math.abs(policy.studyDayBoundaryOffsetMinutes) > 14 * 60
  ) {
    throw new Error('studyDayBoundaryOffsetMinutes must be a safe integer between -840 and 840');
  }
}

function validateCard(card: { complexity: number }): void {
  if (card.complexity !== 1 && card.complexity !== 2 && card.complexity !== 3) {
    throw new Error('card.complexity must be 1, 2, or 3');
  }
}

function validatePreferences(preferences: MemoryPreferenceSnapshot): void {
  if (typeof preferences.liked !== 'boolean') throw new Error('preferences.liked must be boolean');
}

function validateBaseline(baseline: AnkiSnapshotBaselineEvent): void {
  if (baseline.memoryDisposition !== 'applied') {
    throw new Error('anki_snapshot_baseline must have memoryDisposition=applied');
  }
  if (!baseline.coverage.externalCollectionId.trim()) {
    throw new Error('anki_snapshot_baseline coverage requires externalCollectionId');
  }
  if (!baseline.coverage.throughExternalCursor.trim()) {
    throw new Error('anki_snapshot_baseline coverage requires throughExternalCursor');
  }
}

function validateCoveredEvent(
  event: Extract<ReviewMemoryEvent, { memoryDisposition: 'baseline_covered' }>,
  baseline: AnkiSnapshotBaselineEvent | null,
): void {
  if (!baseline || event.coveredByBaselineId !== baseline.id) {
    throw new Error(`baseline_covered event ${event.id} references an unknown baseline`);
  }
  if (event.externalCollectionId !== baseline.coverage.externalCollectionId) {
    throw new Error(`baseline_covered event ${event.id} belongs to a different collection`);
  }
  if (!event.externalEventId.trim()) {
    throw new Error(`baseline_covered event ${event.id} requires externalEventId`);
  }
}

function validateReviewPayload(event: ReviewMemoryEvent): void {
  validateQuality(event.quality, `event ${event.id} quality`);
  if (
    event.responseTimeMs !== null
    && (!Number.isFinite(event.responseTimeMs) || event.responseTimeMs < 0)
  ) {
    throw new Error(`event ${event.id} responseTimeMs must be null or non-negative`);
  }
  validDate(event.occurredAt, `event ${event.id} occurredAt`);
}

function validateQuality(quality: number, label: string): void {
  // Finite, not integer: a conditioned grade carrying objective evidence is
  // fractional, and lands between the rungs via targetStrengthFor. The range
  // is still enforced, and the `< 3` / `>= 3` pass-fail branches are unchanged.
  if (!Number.isFinite(quality) || quality < 0 || quality > 5) {
    throw new Error(`${label} must be a number between 0 and 5`);
  }
}

function validateMemorySequence(sequence: number, eventId: string): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MEMORY_SEQUENCE_MAX) {
    throw new Error(
      `event ${eventId} memorySequence must be a positive persisted integer`,
    );
  }
}

function validateEventId(id: string): void {
  if (typeof id !== 'string' || !id.trim()) throw new Error('Memory event id is required');
}

function validDate(input: MemoryDateInput, label: string): Date {
  if (
    typeof input === 'string'
    && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)
  ) {
    throw new Error(`${label} must include an explicit UTC offset`);
  }
  const parsed = input instanceof Date ? new Date(input) : new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid date`);
  return parsed;
}

function nullableValidDate(input: Date | null, label: string): Date | null {
  return input === null ? null : validDate(input, label);
}

function cloneNullableDate(input: Date | null): Date | null {
  return input === null ? null : new Date(input);
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isCardMemoryStatus(value: string): value is CardMemoryStatus {
  return value === 'learning' || value === 'reviewing' || value === 'mastered' || value === 'retired';
}

function isBaseline(event: MemoryProjectionEvent): event is AnkiSnapshotBaselineEvent {
  return event.kind === 'anki_snapshot_baseline';
}

function startOfStudyDay(date: Date, offsetMinutes: number): number {
  const shifted = date.getTime() + offsetMinutes * 60_000;
  return Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY - offsetMinutes * 60_000;
}
