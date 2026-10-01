import { conceptIdsForTopics, type ConceptTopicIndex } from './scheduler-attribution';

/**
 * Concepts behind the lines a learner missed in a clinical practice sitting
 * (`LearningEvent` eventType 'clinical_practice', metadata.missedTopics), and
 * behind a rhythm strip they got wrong ('group_attempted' with groupType
 * 'rhythm': the strip's topics are its rhythm and findings).
 *
 * Separate from the recent-failure set on purpose: that set is a 2-hour window
 * for in-session remediation and also protects concepts from displacement. A
 * practice miss should last days and nudge, not crowd protection.
 * Spec: docs/superpowers/specs/2026-09-24-clinical-stations-design.md §3.
 */
export const PRACTICE_MISS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PRACTICE_MISS_BOOST = 0.2;

function missedTopicsOf(metadata: unknown): unknown[] | null {
  const m = metadata as {
    missedTopics?: unknown; groupType?: unknown; topics?: unknown;
    correctCount?: unknown; totalSteps?: unknown; skipped?: unknown;
  } | null;
  if (!m) return null;
  if (Array.isArray(m.missedTopics)) return m.missedTopics;
  // A skipped strip is not a miss: leaving is not the same as getting it wrong.
  const missedStrip = m.groupType === 'rhythm' && m.skipped !== true
    && typeof m.correctCount === 'number' && typeof m.totalSteps === 'number'
    && m.correctCount < m.totalSteps;
  return missedStrip && Array.isArray(m.topics) ? m.topics : null;
}

export function derivePracticeMissConceptIds(
  rows: ReadonlyArray<{ metadata: unknown }>,
  conceptTopicIndex: ConceptTopicIndex,
  currentConceptIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const topics = missedTopicsOf(row.metadata);
    if (!topics) continue;
    for (const topic of topics) {
      if (typeof topic !== 'string') continue;
      // One topic, one concept — the same single-match rule card attribution
      // uses. A topic shared by several concepts says nothing specific.
      const matches = conceptIdsForTopics([topic], conceptTopicIndex);
      if (matches.size !== 1) continue;
      const id = matches.values().next().value as string;
      if (currentConceptIds.has(id)) ids.add(id);
    }
  }
  return ids;
}
