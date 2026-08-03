/**
 * Unified Learning Event Recording
 *
 * This is the SINGLE WRITE PATH for all learning interactions.
 * All learning events flow through recordLearningEvent(), which:
 * 1. Writes to the immutable event log (LearningEvent)
 * 2. Updates derived concept state (ConceptState)
 * 3. Triggers any downstream updates (scheduling, struggle detection)
 *
 * See docs/designs/2026-01-17-unified-learning-state.md
 */

import { prisma } from '@/lib/prisma';
import { getExamDateForUser } from '@/lib/rotations';
import { getJurisdictionForRotation, getRotationFromPath } from '@/lib/jurisdiction';
import { logger } from '@/lib/logger';
import { getOrCreateCurrentVersion } from '@/lib/content-version';
import { loadQuestionEmbedding } from '@/lib/manifold';
import { topConceptsForItem } from '@/lib/manifold/scoring';
import { loadConceptSubspace } from '@/lib/manifold/local-subspace';
import { projectToLocal } from '@/lib/manifold/pca';
import { LARGE_QUERY_SIZE } from '@/lib/constants';
import type { Prisma } from '@prisma/client';
import type {
  ReviewDeviceBucket,
  ReviewTimestampSource,
  ReviewWriteTransport,
} from '@/lib/review/review-write-observability';

// =============================================================================
// Types
// =============================================================================

export type LearningEventType =
  | 'card_reviewed'
  | 'mcq_attempted'
  | 'page_read'
  | 'content_expanded'
  | 'video_watched'
  | 'content_exposed'
  | 'group_attempted'
  | 'assessment_attempted'
  | 'self_assessed'
  // Session-lifecycle events — fired by UnifiedReview visible intervals and by
  // useSessionProgress when the daily target is crossed. These don't update
  // ConceptState (sourceType: 'session'); they exist for analytics:
  //   - did this user actually start sessions today?
  //   - did they hit target?
  //   - did lifecycle transport leave an orphaned interval?
  // sourceId is the client-generated session UUID (so start + end correlate).
  | 'session_started'
  | 'session_ended'
  | 'target_crossed';

export interface LearningEventInput {
  userId: string;
  eventType: LearningEventType;
  sourceType: 'card' | 'question' | 'page' | 'group' | 'session';
  sourceId: string;

  // Event-specific data
  quality?: number; // 0-5 for card reviews
  isCorrect?: boolean; // for MCQs
  responseMs?: number;
  metadata?: Record<string, unknown>;

  // Review-write continuity (card/MCQ events only).
  clientOperationId?: string;
  deviceBucket?: ReviewDeviceBucket;
  writeTransport?: ReviewWriteTransport;
  receivedAt?: Date;
  timestampSource?: ReviewTimestampSource;

  // Context
  conceptIds?: string[];
  rotation?: string;
  week?: number;

  // Audit traceability overrides
  auditItemId?: string;
  contentHash?: string;
  /** @internal Source-bound callers may omit mutable ContentVersion lookup. */
  skipContentVersionResolution?: boolean;

  // For testing/replays
  timestamp?: Date;
}

export interface RecordEventResult {
  eventId: string;
  conceptsUpdated: number;
}

/**
 * Canonical event data prepared before a domain transaction begins. The event
 * row is Mode A (immutable source of truth); `derived` is Mode B cache/state
 * work that is safe to run best-effort only after the event commits.
 */
export interface PreparedLearningEvent {
  data: Prisma.LearningEventUncheckedCreateInput;
  derived: {
    userId: string;
    eventType: LearningEventType;
    sourceType: LearningEventInput['sourceType'];
    sourceId: string;
    quality?: number;
    isCorrect?: boolean;
    responseMs?: number;
    conceptIds: string[];
    timestamp: Date;
  };
}

type LearningEventCreateClient = { learningEvent: unknown };

// =============================================================================
// Constants
// =============================================================================

// Decay parameters
export const DEFAULT_DECAY_RATE = 0.1;
export const MIN_CONFIDENCE = 0.1;
export const MAX_CONFIDENCE = 0.95;

// Strength weights by event type. Session-lifecycle events get 0 — they
// don't update ConceptState, only feed analytics. Kept in the map so
// the Record<LearningEventType, number> stays exhaustive (TS enforces).
export const EVENT_STRENGTH: Record<LearningEventType, number> = {
  card_reviewed: 0.3,
  mcq_attempted: 0.4,
  page_read: 0.1,
  content_expanded: 0.15,
  video_watched: 0.2,
  content_exposed: 0.05,
  group_attempted: 0.4,
  assessment_attempted: 0.3,
  self_assessed: 0.3,
  session_started: 0,
  session_ended: 0,
  target_crossed: 0,
};

// Quality multipliers (for card reviews)
export const QUALITY_MULTIPLIERS: Record<number, number> = {
  0: -0.2, // Again - negative impact
  1: 0.0,  // Hard - no change
  2: 0.1,  // Okay
  3: 0.2,  // Good
  4: 0.3,  // Easy
  5: 0.4,  // Perfect
};

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Record a learning event and update all derived state.
 * This is the ONLY function that should write learning data.
 */
export async function prepareLearningEvent(
  input: LearningEventInput,
): Promise<PreparedLearningEvent> {
  if (
    input.skipContentVersionResolution
    && (!input.contentHash || !/^[a-f0-9]{64}$/.test(input.contentHash))
  ) {
    throw new Error(
      'skipContentVersionResolution requires a source-bound SHA-256 contentHash',
    );
  }
  const {
    userId,
    eventType,
    sourceType,
    sourceId,
    quality,
    isCorrect,
    responseMs,
    metadata,
    clientOperationId,
    deviceBucket,
    writeTransport,
    receivedAt,
    timestampSource,
    conceptIds = [],
    rotation,
    week,
    timestamp = new Date(),
  } = input;

  const { auditItemId, contentHash } = await resolveAuditContext(input);

  // Resolve content version for audit trail
  let contentVersionId: string | undefined;
  if (
    !input.skipContentVersionResolution
    && (sourceType === 'card' || sourceType === 'question')
  ) {
    try {
      const version = await getOrCreateCurrentVersion(sourceType, sourceId, 'event');
      contentVersionId = version.id;
    } catch (error) {
      logger.warn('Failed to resolve content version', { sourceType, sourceId, error: String(error) });
    }
  }

  return {
    data: {
      userId,
      eventType,
      sourceType,
      sourceId,
      auditItemId,
      contentHash,
      contentVersionId,
      quality,
      isCorrect,
      responseMs,
      metadata: metadata as Prisma.InputJsonValue | undefined,
      clientOperationId,
      deviceBucket,
      writeTransport,
      receivedAt,
      timestampSource,
      conceptIds,
      rotation,
      week,
      timestamp,
    },
    derived: {
      userId,
      eventType,
      sourceType,
      sourceId,
      quality,
      isCorrect,
      responseMs,
      conceptIds,
      timestamp,
    },
  };
}

/** Create only the immutable Mode-A row, optionally on a caller transaction. */
export async function createPreparedLearningEvent(
  client: LearningEventCreateClient,
  prepared: PreparedLearningEvent,
): Promise<{ id: string }> {
  const writer = client.learningEvent as {
    create(args: {
      data: Prisma.LearningEventUncheckedCreateInput;
      select: { id: true };
    }): PromiseLike<{ id: string }>;
  };
  return writer.create({
    data: prepared.data,
    select: { id: true },
  });
}

/**
 * Update rebuildable Mode-B state after the immutable event has committed.
 * Callers may catch failures here; they must never swallow the event create.
 */
export async function applyLearningEventDerivedState(
  prepared: PreparedLearningEvent,
): Promise<number> {
  const {
    userId,
    eventType,
    sourceType,
    sourceId,
    quality,
    isCorrect,
    responseMs,
    conceptIds,
    timestamp,
  } = prepared.derived;

  let conceptsUpdated = 0;
  if (conceptIds.length > 0) {
    conceptsUpdated = await updateConceptStates(
      userId,
      conceptIds,
      eventType,
      quality,
      isCorrect,
      responseMs,
      timestamp
    );
  }

  if (sourceType === 'question' && conceptIds.length > 0) {
    await updateLocalKnowledgeVectors(userId, sourceId, conceptIds).catch((err) => {
      logger.warn('Failed to update local knowledge vectors', { error: String(err) });
    });
  }

  return conceptsUpdated;
}

export async function recordLearningEvent(
  input: LearningEventInput
): Promise<RecordEventResult> {
  const prepared = await prepareLearningEvent(input);
  const event = await createPreparedLearningEvent(prisma, prepared);
  const conceptsUpdated = await applyLearningEventDerivedState(prepared);

  return {
    eventId: event.id,
    conceptsUpdated,
  };
}

async function resolveAuditContext(
  input: LearningEventInput
): Promise<{ auditItemId?: string; contentHash?: string }> {
  // Session lifecycle rows are analytics boundaries, not auditable content.
  // Avoid a meaningless ContentAuditItem lookup for every start/end beacon.
  if (input.sourceType === 'session') return {};

  if (input.auditItemId || input.contentHash) {
    return {
      auditItemId: input.auditItemId,
      contentHash: input.contentHash,
    };
  }

  let rotation = input.rotation ?? null;
  if (!rotation && input.sourceType === 'page') {
    rotation = getRotationFromPath(input.sourceId);
  }

  if (!rotation && (input.sourceType === 'card' || input.sourceType === 'question')) {
    try {
      if (input.sourceType === 'card') {
        const card = await prisma.card.findUnique({
          where: { id: input.sourceId },
          select: { rotation: true },
        });
        rotation = card?.rotation ?? null;
      } else {
        const question = await prisma.question.findUnique({
          where: { id: input.sourceId },
          select: { rotation: true },
        });
        rotation = question?.rotation ?? null;
      }
    } catch {
      rotation = rotation ?? null;
    }
  }

  const jurisdiction = getJurisdictionForRotation(rotation);
  const targetType = getAuditTargetType(input.sourceType, input.sourceId);

  try {
    const auditItem = await prisma.contentAuditItem.findUnique({
      where: {
        targetType_targetId_jurisdiction: {
        targetType,
        targetId: input.sourceId,
        jurisdiction,
      },
      },
      select: { id: true, currentHash: true },
    });

    if (!auditItem) return {};

    return {
      auditItemId: auditItem.id,
      contentHash: auditItem.currentHash ?? undefined,
    };
  } catch {
    return {};
  }
}

function getAuditTargetType(
  sourceType: LearningEventInput['sourceType'],
  sourceId: string
): string {
  if (sourceType !== 'page') return sourceType;
  if (sourceId.startsWith('/deep-dive/')) return 'deep-dive';
  return 'page';
}

// =============================================================================
// Concept State Updates
// =============================================================================

/**
 * Update ConceptState for affected concepts.
 * This recomputes the derived state from recent events.
 */
async function updateConceptStates(
  userId: string,
  conceptIds: string[],
  eventType: LearningEventType,
  quality: number | undefined,
  isCorrect: boolean | undefined,
  responseMs: number | undefined,
  now: Date
): Promise<number> {
  let updated = 0;

  for (const conceptId of conceptIds) {
    try {
      await updateSingleConceptState(
        userId,
        conceptId,
        eventType,
        quality,
        isCorrect,
        responseMs,
        now
      );
      updated++;
    } catch (error) {
      logger.error(`Failed to update ConceptState for ${conceptId}`, { error: String(error) });
    }
  }

  return updated;
}

/**
 * Update a single concept's derived state.
 */
async function updateSingleConceptState(
  userId: string,
  conceptId: string,
  eventType: LearningEventType,
  quality: number | undefined,
  isCorrect: boolean | undefined,
  responseMs: number | undefined,
  now: Date
): Promise<void> {
  // Get existing state
  const existing = await prisma.conceptState.findUnique({
    where: { userId_conceptId: { userId, conceptId } },
  });

  // Get recent events for this concept (for computing aggregates)
  const recentEvents = await prisma.learningEvent.findMany({
    where: {
      userId,
      conceptIds: { has: conceptId },
      timestamp: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }, // Last 30 days
    },
    orderBy: { timestamp: 'desc' },
    take: LARGE_QUERY_SIZE,
  });

  // Compute new state
  const newState = computeConceptState(
    existing,
    recentEvents,
    eventType,
    quality,
    isCorrect,
    responseMs,
    now
  );

  // Get exam date for decay projection
  const concept = await prisma.concept.findUnique({
    where: { id: conceptId },
    select: { rotation: true },
  });

  let recallOnExamDay = newState.recallProbability;
  if (concept?.rotation) {
    const examDate = await getExamDateForUser(concept.rotation, userId);
    if (examDate) {
      const daysToExam = Math.max(
        0,
        (examDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );
      recallOnExamDay = applyDecay(
        newState.recallProbability,
        daysToExam,
        newState.confidence,
        newState.decayRate
      );
    }
  }

  // Upsert the state
  await prisma.conceptState.upsert({
    where: { userId_conceptId: { userId, conceptId } },
    update: {
      recallProbability: newState.recallProbability,
      recallOnExamDay,
      confidence: newState.confidence,
      decayRate: newState.decayRate,
      lastProbeAt: newState.lastProbeAt,
      lastExposureAt: now,
      avgResponseMs: newState.avgResponseMs,
      responseVariance: newState.responseVariance,
      recentFailRate: newState.recentFailRate,
      exposureCount: newState.exposureCount,
      probeCount: newState.probeCount,
      lastComputed: now,
    },
    create: {
      userId,
      conceptId,
      recallProbability: newState.recallProbability,
      recallOnExamDay,
      confidence: newState.confidence,
      decayRate: newState.decayRate,
      lastProbeAt: newState.lastProbeAt,
      lastExposureAt: now,
      avgResponseMs: newState.avgResponseMs,
      responseVariance: newState.responseVariance,
      recentFailRate: newState.recentFailRate,
      exposureCount: newState.exposureCount,
      probeCount: newState.probeCount,
      lastComputed: now,
    },
  });
}

// =============================================================================
// Local Knowledge Vector Update (Layer 2)
// =============================================================================

const LOCAL_KNOWLEDGE_ALPHA = 0.1; // EMA smoothing factor

/**
 * Update localKnowledgeVector for each concept after a question is answered.
 * Projects the question into the concept's local PCA subspace and updates
 * the user's local knowledge vector via exponential moving average.
 */
async function updateLocalKnowledgeVectors(
  userId: string,
  questionId: string,
  conceptIds: string[]
): Promise<void> {
  // Load question's 1024D embedding
  const questionEmb = await loadQuestionEmbedding(questionId);
  if (!questionEmb) return;

  for (const conceptId of conceptIds) {
    try {
      const subspace = await loadConceptSubspace(conceptId);
      if (!subspace) continue;

      // Project question into local PCA space
      const localProj = projectToLocal(questionEmb, subspace.mean, subspace.basis);
      const k = localProj.length;

      // Load current local knowledge vector
      const state = await prisma.conceptState.findUnique({
        where: { userId_conceptId: { userId, conceptId } },
        select: { localKnowledgeVector: true },
      });

      const current =
        state?.localKnowledgeVector?.length === k
          ? state.localKnowledgeVector
          : new Array(k).fill(0);

      // Exponential moving average update
      const updated = current.map(
        (v, i) => v * (1 - LOCAL_KNOWLEDGE_ALPHA) + localProj[i] * LOCAL_KNOWLEDGE_ALPHA
      );

      await prisma.conceptState.update({
        where: { userId_conceptId: { userId, conceptId } },
        data: {
          localKnowledgeVector: updated,
          localKnowledgeUpdatedAt: new Date(),
        },
      });
    } catch {
      // Non-critical — skip this concept silently
    }
  }
}

// =============================================================================
// State Computation
// =============================================================================

export interface ComputedState {
  recallProbability: number;
  confidence: number;
  decayRate: number;
  lastProbeAt: Date | null;
  avgResponseMs: number | null;
  responseVariance: number | null;
  recentFailRate: number;
  exposureCount: number;
  probeCount: number;
}

export interface RecentEvent {
  eventType: string;
  quality: number | null;
  isCorrect: boolean | null;
  responseMs: number | null;
  timestamp: Date;
}

/**
 * Compute the new concept state from existing state and recent events.
 */
export function computeConceptState(
  existing: {
    recallProbability: number;
    confidence: number;
    decayRate: number;
    avgResponseMs: number | null;
    exposureCount: number;
    probeCount: number;
  } | null,
  recentEvents: RecentEvent[],
  eventType: LearningEventType,
  quality: number | undefined,
  isCorrect: boolean | undefined,
  responseMs: number | undefined,
  now: Date
): ComputedState {
  // Start from existing or defaults
  let recallProbability = existing?.recallProbability ?? 0;
  let confidence = existing?.confidence ?? MIN_CONFIDENCE;
  let decayRate = existing?.decayRate ?? DEFAULT_DECAY_RATE;
  let avgResponseMs = existing?.avgResponseMs ?? null;
  let exposureCount = existing?.exposureCount ?? 0;
  let probeCount = existing?.probeCount ?? 0;

  // Increment exposure count
  exposureCount += 1;

  // Check if this is a probe (active test)
  const isProbe = eventType === 'card_reviewed'
    || eventType === 'mcq_attempted'
    || eventType === 'group_attempted'
    || eventType === 'assessment_attempted'
    || eventType === 'self_assessed';
  let lastProbeAt: Date | null = null;

  if (isProbe) {
    probeCount += 1;
    lastProbeAt = now;
  }

  // Compute event strength
  let strength = EVENT_STRENGTH[eventType] ?? 0.1;

  // Apply quality multiplier for card reviews
  if (
    (eventType === 'card_reviewed'
      || eventType === 'assessment_attempted'
      || eventType === 'self_assessed')
    && quality !== undefined
  ) {
    strength += QUALITY_MULTIPLIERS[quality] ?? 0;
  }

  // Apply correctness for MCQs
  if (eventType === 'mcq_attempted' && isCorrect !== undefined) {
    strength = isCorrect ? strength : strength * -0.5;
  }

  // Update recall probability (bounded 0-1)
  recallProbability = Math.max(0, Math.min(1, recallProbability + strength));

  // Update confidence (increases with exposure, decreases with failures)
  const confidenceDelta = isProbe
    ? (quality !== undefined && quality >= 3) || isCorrect
      ? 0.05
      : -0.02
    : 0.01;
  confidence = Math.max(
    MIN_CONFIDENCE,
    Math.min(MAX_CONFIDENCE, confidence + confidenceDelta)
  );

  // Update decay rate (faster decay if struggling, slower if consistent)
  if (isProbe) {
    const success = (quality !== undefined && quality >= 3) || isCorrect;
    decayRate = success
      ? Math.max(0.05, decayRate - 0.01) // Slower decay on success
      : Math.min(0.2, decayRate + 0.02); // Faster decay on failure
  }

  // Update response time (exponential moving average)
  if (responseMs !== undefined) {
    if (avgResponseMs === null) {
      avgResponseMs = responseMs;
    } else {
      avgResponseMs = 0.3 * responseMs + 0.7 * avgResponseMs;
    }
  }

  // Compute response variance from recent events
  const responseTimes = recentEvents
    .filter((e) => e.responseMs !== null)
    .map((e) => e.responseMs as number);
  let responseVariance: number | null = null;
  if (responseTimes.length >= 3 && avgResponseMs !== null) {
    const variance =
      responseTimes.reduce((sum, t) => sum + (t - avgResponseMs!) ** 2, 0) /
      responseTimes.length;
    responseVariance = Math.sqrt(variance);
  }

  // Compute recent fail rate (last 24h)
  const last24h = recentEvents.filter(
    (e) => e.timestamp.getTime() > now.getTime() - 24 * 60 * 60 * 1000
  );
  const probes24h = last24h.filter(
    (e) =>
      e.eventType === 'card_reviewed' ||
      e.eventType === 'mcq_attempted' ||
      e.eventType === 'group_attempted' ||
      e.eventType === 'assessment_attempted' ||
      e.eventType === 'self_assessed'
  );
  const fails24h = probes24h.filter(
    (e) =>
      (e.quality !== null && e.quality < 3) ||
      (e.isCorrect !== null && !e.isCorrect)
  );
  const recentFailRate =
    probes24h.length > 0 ? fails24h.length / probes24h.length : 0;

  return {
    recallProbability,
    confidence,
    decayRate,
    lastProbeAt,
    avgResponseMs,
    responseVariance,
    recentFailRate,
    exposureCount,
    probeCount,
  };
}

/**
 * Apply memory decay to a recall probability.
 */
export function applyDecay(
  recall: number,
  days: number,
  confidence: number,
  decayRate: number
): number {
  // Higher confidence = slower decay
  const effectiveDecay = decayRate * (1 - confidence * 0.5);
  return recall * Math.exp(-effectiveDecay * days);
}

// =============================================================================
// Utility Functions
// =============================================================================

// Geometric fallback for cards the topic-overlap join cannot place. Topic
// strings mis-associate (an aortic-dissection card matching "opioid pharmacology"
// via a shared `pain` tag) and leave ~37% of CC cards concept-less entirely.
// When topic-overlap yields nothing, fall back to embedding proximity: the card's
// nearest concepts in the same rotation, capped and floored so we credit only
// genuinely-related concepts. Topic-overlap stays primary (zero change for the
// ~63% it places); this is purely additive coverage for the unattached tail.
const GEO_FALLBACK_TOP_K = 3;
const GEO_FALLBACK_MIN_SIM = 0.5;

/**
 * Get concept IDs for a card. Primary: topic→concept overlap. Fallback: nearest
 * concepts by embedding cosine (see GEO_FALLBACK_* above).
 */
export async function getConceptIdsForCard(cardId: string): Promise<string[]> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { topics: true, rotation: true },
  });

  if (!card) return [];

  if (card.topics.length > 0) {
    const concepts = await prisma.concept.findMany({
      where: {
        rotation: card.rotation,
        topics: { hasSome: card.topics },
      },
      select: { id: true },
    });
    if (concepts.length > 0) return concepts.map((c) => c.id);
  }

  const geo = await topConceptsForItem({
    itemTable: 'card_embeddings',
    itemIdColumn: 'card_id',
    itemId: cardId,
    rotation: card.rotation,
    topK: GEO_FALLBACK_TOP_K,
    minSimilarity: GEO_FALLBACK_MIN_SIM,
  });
  return geo.map((g) => g.conceptId);
}

/**
 * Get concept IDs for a question (via QuestionConcept join).
 */
export async function getConceptIdsForQuestion(
  questionId: string
): Promise<string[]> {
  const links = await prisma.questionConcept.findMany({
    where: { questionId },
    select: { conceptId: true },
  });

  return links.map((l) => l.conceptId);
}

/**
 * Get concept IDs for a page (via page topics → concepts mapping).
 */
export async function getConceptIdsForPage(
  rotation: string,
  topics: string[]
): Promise<string[]> {
  if (topics.length === 0) return [];

  const concepts = await prisma.concept.findMany({
    where: {
      rotation,
      topics: { hasSome: topics },
    },
    select: { id: true },
  });

  return concepts.map((c) => c.id);
}
