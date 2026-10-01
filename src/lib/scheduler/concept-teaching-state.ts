/**
 * Concept teaching state — bucket a continuous ConceptState into a small
 * set of pedagogical states the scheduler can plan against.
 *
 * The four states map to fundamentally different teaching needs:
 *
 *   naive         — never seen this concept. Don't test cold; pre-teach.
 *   learning      — seen but failing. Bridge cards + scaffolding before
 *                   we try to test again.
 *   consolidating — getting it more often than not, but still gaps. Time
 *                   for cross-format probing (cloze + MCQ + comparison)
 *                   to find the gaps before exam.
 *   mastered      — solid recall AND high confidence. Just maintain via
 *                   spaced review; don't waste session slots drilling.
 *
 * Why fragile mastery (high recall, low confidence) is NOT mastered:
 *   ConceptState.confidence captures epistemic uncertainty in our own
 *   estimate — small N, recent volatility, contradictory signals. Even
 *   if recallOnExamDay says 0.9, if confidence is 0.3 we don't actually
 *   know whether the user knows it. Bucket as consolidating and keep
 *   probing.
 *
 * Pure function: no DB access, no side effects, no Date.now(). Callers
 * pass already-computed values (the scheduler already has
 * recallOnExamDay; we don't re-derive it here).
 */

export type TeachingState = 'naive' | 'learning' | 'consolidating' | 'mastered';

export interface TeachingStateInput {
  /** ConceptState.exposureCount — total interactions, any modality. */
  exposureCount: number;
  /**
   * ConceptState.recallOnExamDay — decay-projected P(recall) at the exam
   * date. The scheduler already computes this via applyDecay; we just
   * bucket.
   */
  recallOnExamDay: number;
  /**
   * ConceptState.confidence — our epistemic certainty (0..1). Distinct
   * from recallProbability: confidence is "how sure are we?", recall is
   * "what's the answer?".
   */
  confidence: number;
}

/**
 * Thresholds — exported so tests, audits, and the teaching-plan builder
 * can reference the same numbers. Move-by-feel is dangerous here; if you
 * change a threshold, do it as a deliberate calibration with data.
 */
export const TEACHING_STATE_THRESHOLDS = {
  /** Below this recall, we treat the concept as failing — not test-ready. */
  LEARNING_RECALL_CEILING: 0.5,
  /** Below this recall, we keep probing — not yet maintenance. */
  CONSOLIDATING_RECALL_CEILING: 0.85,
  /** Below this confidence, treat as fragile even if recall is high. */
  MASTERY_CONFIDENCE_FLOOR: 0.7,
} as const;

export function classifyTeachingState(input: TeachingStateInput): TeachingState {
  const { exposureCount, recallOnExamDay, confidence } = input;
  const T = TEACHING_STATE_THRESHOLDS;

  // Never seen → can't be anything but naive. Recall/confidence values
  // are meaningless without exposure; ignore them.
  if (exposureCount <= 0) return 'naive';

  // Failing — bridge + scaffold before next probe.
  if (recallOnExamDay < T.LEARNING_RECALL_CEILING) return 'learning';

  // Getting it but with gaps — cross-format probe.
  if (recallOnExamDay < T.CONSOLIDATING_RECALL_CEILING) return 'consolidating';

  // High recall + low confidence = fragile mastery. Don't graduate yet.
  if (confidence < T.MASTERY_CONFIDENCE_FLOOR) return 'consolidating';

  // High recall AND high confidence — maintain via spaced review.
  return 'mastered';
}

/**
 * What kind of teaching arc each state needs. Consumed by the
 * teaching-plan builder (step B in the scheduler refactor) to pick how
 * many items and in what shape.
 *
 * Not enforced as a type — these are pedagogical guidelines the planner
 * adapts to what's actually available in the rotation. If we say
 * "naive needs a teaching item first" but no teaching content exists,
 * the planner falls back gracefully rather than serving nothing.
 */
export interface TeachingArc {
  /** Pre-teach before any probe: video, deep-dive paragraph, or simplest C1 card. */
  preTeach: boolean;
  /** Target number of items to serve for this concept in one session. */
  targetItems: number;
  /** Whether to actively diversify formats (cloze + MCQ + comparison). */
  multiFormat: boolean;
  /** Whether to escalate quickly on failure (re-prioritize within session). */
  failureEscalation: boolean;
}

const ARCS: Record<TeachingState, TeachingArc> = {
  naive: {
    preTeach: true,
    targetItems: 2, // teach + one gentle probe
    multiFormat: false,
    failureEscalation: false, // not actually struggling yet
  },
  learning: {
    preTeach: true, // bridge card before next test
    targetItems: 3, // bridge + 2 attempts at different angles
    multiFormat: true,
    failureEscalation: true,
  },
  consolidating: {
    preTeach: false,
    targetItems: 3, // cross-format probe
    multiFormat: true,
    failureEscalation: true,
  },
  mastered: {
    preTeach: false,
    targetItems: 1, // maintenance touch only
    multiFormat: false,
    failureEscalation: false,
  },
};

export function teachingArcFor(state: TeachingState): TeachingArc {
  return ARCS[state];
}
