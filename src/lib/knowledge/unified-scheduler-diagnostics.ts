/**
 * Unified scheduler: diagnostics
 *
 * Read-only view of concept states for a rotation. Moved out of
 * unified-scheduler.ts unchanged; that module re-exports it.
 */

import { prisma } from '@/lib/prisma';
import { getExamDateForUser } from '@/lib/rotations';
import { applyDecay, projectRecallToExamDay } from './state';
import type { ConceptState } from './unified-scheduler-types';
import { DEFAULTS, RECALL_RANKING_HORIZON_DAYS } from './unified-scheduler-config';

// =============================================================================
// Diagnostic Functions
// =============================================================================

/**
 * Get a diagnostic view of concept states for a rotation
 * Useful for understanding why certain items are being recommended
 */
export async function getConceptDiagnostics(
  userId: string,
  rotation: string,
  options: { week?: number; limit?: number } = {}
): Promise<ConceptState[]> {
  const { week, limit = 20 } = options;

  const examDate = await getExamDateForUser(rotation, userId);
  const daysToExam = examDate
    ? Math.max(0, (examDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 45;

  const concepts = await prisma.concept.findMany({
    where: {
      rotation,
      ...(week !== undefined ? { week } : {}),
    },
    select: { id: true, name: true, week: true, examWeight: true },
  });

  const conceptIds = concepts.map((c) => c.id);
  const stateRecords = await prisma.conceptState.findMany({
    where: { userId, conceptId: { in: conceptIds } },
  });
  const stateMap = new Map(stateRecords.map((s) => [s.conceptId, s]));

  const now = new Date();
  const states: ConceptState[] = concepts.map((concept) => {
    const state = stateMap.get(concept.id);
    const daysSinceProbe = state?.lastProbeAt
      ? (now.getTime() - state.lastProbeAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;
    const daysSinceExposure = state?.lastExposureAt
      ? (now.getTime() - state.lastExposureAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;

    const storedRecall = state?.recallProbability ?? 0;
    const confidence = state?.confidence ?? 0;
    const exposureCount = state?.exposureCount ?? 0;

    const currentRecall =
      daysSinceExposure < Infinity
        ? applyDecay(storedRecall, daysSinceExposure, confidence)
        : 0;
    // True exam-day recall — the SEMANTIC value for diagnostics and urgency.
    // Candidate difficulty is chosen from current decayed recall in the serving
    // path, not from this forecast.
    const recallOnExamDay = projectRecallToExamDay(currentRecall, daysToExam, confidence);
    // RANKING recall: the same projection horizon-capped so priority stays
    // discriminating far from exam, where the true exam-day recall collapses to
    // ~0 for every concept (examPressure carries exam urgency separately). Used
    // ONLY for the priority gap below — never as recallOnExamDay's substitute
    // (BACKLOG #9 / adversarial review: capping it everywhere changed
    // hub-readiness, not just the sort).
    const rankingRecall = projectRecallToExamDay(currentRecall, daysToExam, confidence, RECALL_RANKING_HORIZON_DAYS);

    let intervention: 'probe' | 'remediate' | 'reinforce';
    if (confidence < DEFAULTS.confidenceThreshold || exposureCount < 3) {
      intervention = 'probe';
    } else if (recallOnExamDay < DEFAULTS.recallThreshold) {
      intervention = 'remediate';
    } else if (daysSinceProbe > DEFAULTS.daysSinceProbeThreshold) {
      intervention = 'probe';
    } else {
      intervention = 'reinforce';
    }

    const gapScore = Math.max(0, DEFAULTS.targetRecall - rankingRecall);
    const confidenceBoost = confidence < DEFAULTS.confidenceThreshold ? 0.2 : 0;
    const staleBoost = daysSinceProbe > DEFAULTS.daysSinceProbeThreshold ? 0.1 : 0;
    const examWeightMultiplier = (concept.examWeight || 1) / 3;
    const priority = (gapScore + confidenceBoost + staleBoost) * examWeightMultiplier;

    return {
      conceptId: concept.id,
      conceptName: concept.name,
      currentRecall: Math.round(currentRecall * 1000) / 1000,
      recallOnExamDay: Math.round(recallOnExamDay * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
      exposureCount,
      daysSinceProbe: Math.round(daysSinceProbe * 10) / 10,
      daysSinceExposure: Math.round(daysSinceExposure * 10) / 10,
      priority: Math.round(priority * 1000) / 1000,
      intervention,
    };
  });

  return states.sort((a, b) => b.priority - a.priority).slice(0, limit);
}
