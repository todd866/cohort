import { prisma } from '@/lib/prisma';
import { shuffle, shuffleWithSeed } from '@/lib/utils/shuffle';
import type { QuestionFamiliarity } from '@/lib/knowledge/question-retirement';
import {
  prioritizeLeastRecentlyServedContrastSiblings,
  questionSuppressionKey,
} from '@/lib/knowledge/variant-suppression';

type QuestionRow = {
  id: string;
  variantGroupId: string | null;
  variantType: string | null;
  [key: string]: unknown;
};

/**
 * Optional request-frozen entropy for paired scheduler evaluation. This only
 * removes wall-clock/random drift; it does not freeze the backing DB reads.
 */
export interface QuestionVariantSelectionDeterminism {
  nowMs: number;
  seed: string;
}

/**
 * Select questions with variant awareness:
 * - Pick only ONE sibling for groups whose variantType has suppression semantics
 * - Do not collapse hand-authored topic buckets that merely reuse variantGroupId
 * - For contrast sets, explicitly pick the least-recently delivered eligible sibling
 * - Otherwise prefer variants the user hasn't answered recently (or at all)
 *
 * This prevents pattern matching by ensuring users see different phrasings
 * of the same concept each time.
 */
export async function selectVariantAwareQuestions<T extends QuestionRow>(
  questions: T[],
  userId: string,
  targetCount: number,
  recentWindowHours: number = 72, // 3 days
  deliveredFamiliarity?: Map<string, QuestionFamiliarity>,
  selectionDeterminism?: QuestionVariantSelectionDeterminism,
): Promise<T[]> {
  if (questions.length === 0) return [];

  const candidateIds = [...new Set(questions.map((q) => q.id))];
  const candidateIdSet = new Set(candidateIds);

  // Build map of questionId -> last answered date (single query via DISTINCT ON)
  const lastAnsweredByQuestion = new Map<string, Date>();

  if (deliveredFamiliarity) {
    for (const [questionId, familiarity] of deliveredFamiliarity) {
      if (candidateIdSet.has(questionId)) {
        lastAnsweredByQuestion.set(questionId, new Date(familiarity.lastSeenAtMs));
      }
    }
  } else if (candidateIds.length > 0) {
    const lastResponses = await prisma.questionResponse.findMany({
      where: {
        userId,
        questionId: { in: candidateIds },
      },
      select: {
        questionId: true,
        createdAt: true,
      },
      distinct: ['questionId'],
      orderBy: [{ questionId: 'asc' }, { createdAt: 'desc' }],
    });

    for (const response of lastResponses) {
      lastAnsweredByQuestion.set(response.questionId, response.createdAt);
    }
  }

  const familiarity = deliveredFamiliarity ?? new Map(
    [...lastAnsweredByQuestion].map(([questionId, seenAt]) => [
      questionId,
      { lastSeenAtMs: seenAt.getTime(), corrects: 0 },
    ]),
  );
  const contrastOrdered = prioritizeLeastRecentlyServedContrastSiblings(
    questions,
    (question) => question.id,
    familiarity,
  );

  // Group only semantically suppressible families. The raw variantGroupId column
  // also contains hand-authored TOPIC BUCKETS (`anchor`, `different-scenario`,
  // etc.); collapsing those silently starves unrelated questions. Duplicate ids
  // still share a solo key so a duplicated input row cannot double-serve.
  const groupedQuestions = new Map<string, T[]>();
  for (const q of contrastOrdered) {
    const suppressKey = questionSuppressionKey(q);
    const groupKey = suppressKey ? `__family:${suppressKey}` : `__single:${q.id}`;
    const group = groupedQuestions.get(groupKey) ?? [];
    group.push(q);
    groupedQuestions.set(groupKey, group);
  }

  const deterministicSelection = selectionDeterminism
    && Number.isFinite(selectionDeterminism.nowMs)
    && /^[a-f0-9]{64}$/.test(selectionDeterminism.seed)
    ? selectionDeterminism
    : null;
  const selectionNowMs = deterministicSelection?.nowMs ?? Date.now();
  const recentThreshold = new Date(selectionNowMs - recentWindowHours * 60 * 60 * 1000);
  const pickOne = (pool: T[], scope: string): T => {
    if (deterministicSelection) {
      return shuffleWithSeed(
        pool,
        `${deterministicSelection.seed}\0question-variant\0${scope}`,
      )[0]!;
    }
    return pool[Math.floor(Math.random() * pool.length)]!;
  };

  // Select one question per variant group
  const selected: T[] = [];

  for (const [groupKey, variants] of groupedQuestions) {
    if (variants[0]?.variantType === 'contrast-set') {
      selected.push(variants[0]);
      continue;
    }
    // Prefer variants never answered
    const neverAnswered = variants.filter((v) => !lastAnsweredByQuestion.has(v.id));
    if (neverAnswered.length > 0) {
      selected.push(pickOne(neverAnswered, `${groupKey}\0never-answered`));
      continue;
    }

    // Then prefer variants not answered recently
    const notRecent = variants.filter((v) => {
      const lastAnswered = lastAnsweredByQuestion.get(v.id);
      return lastAnswered ? lastAnswered < recentThreshold : true;
    });

    const pool = notRecent.length > 0 ? notRecent : variants;
    pool.sort((a, b) => {
      const aMs = lastAnsweredByQuestion.get(a.id)?.getTime() ?? 0;
      const bMs = lastAnsweredByQuestion.get(b.id)?.getTime() ?? 0;
      return aMs - bMs;
    });

    const oldestMs = lastAnsweredByQuestion.get(pool[0]!.id)?.getTime();
    const equallyOld =
      typeof oldestMs === 'number'
        ? pool.filter((v) => lastAnsweredByQuestion.get(v.id)?.getTime() === oldestMs)
        : pool;

    selected.push(pickOne(equallyOld, `${groupKey}\0equally-old`));
  }

  // Shuffle and limit to target count
  const ordered = deterministicSelection
    ? shuffleWithSeed(
        selected,
        `${deterministicSelection.seed}\0question-variant\0final-order`,
      )
    : shuffle(selected);
  return ordered.slice(0, targetCount);
}
