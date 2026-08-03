/**
 * DB wrapper for the concept Map's honest terrain signal. Loads a rotation's
 * concepts + the user's recent graded attempts from the raw LearningEvent log,
 * normalises each to a success score, then delegates the (tested, pure) scoring
 * to computeConceptTerrain.
 *
 * See docs/superpowers/specs/2026-07-22-mobile-review-desktop-concept-map.md §4.2.
 */

import { prisma } from '@/lib/prisma';
import {
  computeConceptTerrain,
  attemptScore,
  type ConceptTerrainNode,
  type ConceptTerrainOptions,
  type TerrainAttempt,
} from './concept-terrain';

/** Bounds the event scan; wider than the accuracy window so once-known-but-stale
 *  concepts read as provisional rather than unexplored. */
const EVENT_LOOKBACK_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function getConceptTerrain(
  userId: string,
  rotation: string,
  options: Partial<ConceptTerrainOptions> = {},
): Promise<ConceptTerrainNode[]> {
  const now = options.now ?? new Date();

  const concepts = await prisma.concept.findMany({
    where: { rotation },
    select: { id: true, name: true, week: true, examWeight: true },
  });
  if (concepts.length === 0) return [];
  const conceptIdSet = new Set(concepts.map((c) => c.id));

  const since = new Date(now.getTime() - EVENT_LOOKBACK_DAYS * DAY_MS);
  const events = await prisma.learningEvent.findMany({
    where: {
      userId,
      timestamp: { gte: since },
      // Scope by the concepts, not LearningEvent.rotation (nullable on otherwise-
      // attributable events). Only graded events (MCQ isCorrect or cloze quality).
      conceptIds: { hasSome: [...conceptIdSet] },
      OR: [{ isCorrect: { not: null } }, { quality: { not: null } }],
    },
    select: { sourceId: true, conceptIds: true, isCorrect: true, quality: true, timestamp: true },
  });

  const attempts: TerrainAttempt[] = [];
  for (const e of events) {
    const score = attemptScore(e);
    if (score === null) continue;
    // One grade tagged with N concepts is 1/N evidence for each — de-smear so a
    // 12-concept card doesn't collapse every concept to the global mean.
    const attribution = e.conceptIds.length > 0 ? 1 / e.conceptIds.length : 1;
    for (const cid of e.conceptIds) {
      if (conceptIdSet.has(cid)) {
        attempts.push({ conceptId: cid, itemId: e.sourceId, score, at: e.timestamp, weight: attribution });
      }
    }
  }

  return computeConceptTerrain({ concepts, attempts }, { ...options, now });
}
