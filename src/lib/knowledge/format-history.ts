import { prisma } from '@/lib/prisma';

/**
 * Map of conceptId → set of cognitive formats the user has been served
 * for that concept within the recency window. Used by the question
 * candidate ranker to prefer un-seen formats — variety in *how* a
 * concept is probed, not just *which* concept.
 */
export type RecentFormatsByConcept = Map<string, Set<string>>;

const DEFAULT_LOOKBACK_DAYS = 14;

/**
 * For each concept the scheduler is considering, what cognitive formats
 * has the user already been served recently?
 *
 * Joins QuestionResponse → QuestionConcept → Question.format, scoped to
 * the user + the conceptIds the scheduler is about to rank, over the
 * lookback window.
 *
 * Returns a Map keyed by conceptId. Concepts with no recent attempts
 * are absent from the map (treat as "no formats seen yet").
 */
export async function fetchRecentlyServedFormatsByConcept(
  userId: string,
  conceptIds: string[],
  options: { lookbackDays?: number } = {},
): Promise<RecentFormatsByConcept> {
  const result: RecentFormatsByConcept = new Map();
  if (conceptIds.length === 0) return result;

  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  // Single query: response → links to in-scope concepts → question.format.
  // Distinct (conceptId, format) so we don't pull millions of rows back.
  const rows = await prisma.questionResponse.findMany({
    where: {
      userId,
      createdAt: { gte: since },
      question: {
        format: { not: null },
        concepts: { some: { conceptId: { in: conceptIds } } },
      },
    },
    select: {
      question: {
        select: {
          format: true,
          concepts: { select: { conceptId: true } },
        },
      },
    },
  });

  const conceptIdSet = new Set(conceptIds);
  for (const r of rows) {
    const fmt = r.question?.format;
    if (!fmt) continue;
    for (const link of r.question.concepts) {
      if (!conceptIdSet.has(link.conceptId)) continue;
      const set = result.get(link.conceptId) ?? new Set<string>();
      set.add(fmt);
      result.set(link.conceptId, set);
    }
  }

  return result;
}
