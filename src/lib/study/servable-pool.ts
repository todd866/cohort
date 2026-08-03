/**
 * Single source of truth for "what content is servable for user U,
 * rotation R, week W?".
 *
 * Every read path that needs to count or match the scheduler's pool must
 * build its where-clause from these helpers. Without a shared predicate,
 * `computeNewRemaining`, the unified-scheduler, and the rescue path drift
 * apart, producing visible bugs:
 *   - counter says "5 new remaining" but scheduler returns 0
 *     (counter ignored open-issue exclusions, scheduler applied them)
 *   - rescue path resurfaces cards with open ContentIssue rows that the
 *     scheduler intentionally filtered out
 *
 * The unified-scheduler still applies its own internal exclusion sets
 * for recent exposures and topic cooldowns — but the *baseline pool*
 * comes from this module.
 */

import type { Prisma } from '@prisma/client';
import { withDefaultQuestionServingPolicy } from '@/lib/questions/source-policy';
import { getOpenIssueExclusions } from '@/lib/content-quality/open-issue-exclusions';
import { getExcludedQuestionIds } from '@/lib/question-bank';
import { userIdCanAccessPrivateSources } from '@/lib/questions/private-access';

/** Topics whose presence on a card/question disqualifies it from any user-facing pool. */
export const EXCLUDED_POOL_TOPICS = ['_needs-image', '_incomplete-data'] as const;

const EXCLUDED_TOPICS_NOT: Prisma.CardWhereInput['NOT'] = {
  topics: { hasSome: [...EXCLUDED_POOL_TOPICS] },
};

/**
 * Image-as-prompt cards (`imageRole === 'prompt'`) are useless without their
 * copyright image, so they're served ONLY to copyright-tier users. For
 * everyone else this returns a predicate excluding them. Prisma translates a
 * scalar `not` to SQL `<>`, where null rows evaluate UNKNOWN and are excluded;
 * the explicit OR is therefore required to keep today's ordinary null-role
 * cards servable. Spread this as a sibling key into a card where-clause.
 */
export function imagePromptCardWhere(isCopyrightTier: boolean): Prisma.CardWhereInput {
  return isCopyrightTier ? {} : {
    OR: [
      { imageRole: null },
      { imageRole: { not: 'prompt' } },
    ],
  };
}

/** Per-user filters that vary across requests but are stable for a single session. */
export interface ServablePoolFilters {
  /** Card IDs flagged with open ContentIssue rows (and their linked partners). */
  openIssueCardIds: Set<string>;
  /** Question IDs flagged with open ContentIssue rows (and their linked partners). */
  openIssueQuestionIds: Set<string>;
  /** Question IDs hidden globally (e.g., legacy/.epub imports tracked via question-bank). */
  globallyExcludedQuestionIds: Set<string>;
  /** Whether the caller may see private-source questions. */
  allowPrivateSources: boolean;
}

/** Loads the per-user pool filters in parallel. Each underlying call has its own
 *  error path; on individual failure we fall closed (no extra access). */
export async function loadServablePoolFilters(userId: string): Promise<ServablePoolFilters> {
  const emptySet = () => new Set<string>();
  const [openIssue, globallyExcluded, allowPrivate] = await Promise.all([
    getOpenIssueExclusions().catch(() => ({ cardIds: emptySet(), questionIds: emptySet() })),
    getExcludedQuestionIds().catch(() => emptySet()),
    userIdCanAccessPrivateSources(userId).catch(() => false),
  ]);
  return {
    openIssueCardIds: openIssue.cardIds,
    openIssueQuestionIds: openIssue.questionIds,
    globallyExcludedQuestionIds: globallyExcluded,
    allowPrivateSources: allowPrivate,
  };
}

export interface BuildServableCardWhereOptions {
  rotation: string;
  /** Null means "all weeks". */
  week: number | null;
  /** When set, also restricts to cards the user has never seen. */
  newOnlyForUserId?: string;
  openIssueCardIds: ReadonlySet<string>;
}

/** Server-side where clause for the rotation card pool. */
export function buildServableCardWhere(options: BuildServableCardWhereOptions): Prisma.CardWhereInput {
  const { rotation, week, newOnlyForUserId, openIssueCardIds } = options;
  const where: Prisma.CardWhereInput = {
    rotation,
    deletedAt: null,
    shelvedAt: null,
    NOT: EXCLUDED_TOPICS_NOT,
  };
  if (week !== null) where.week = week;
  if (openIssueCardIds.size > 0) where.id = { notIn: [...openIssueCardIds] };
  if (newOnlyForUserId) where.progress = { none: { userId: newOnlyForUserId } };
  return where;
}

export interface BuildServableQuestionWhereOptions {
  rotation: string;
  week: number | null;
  newOnlyForUserId?: string;
  openIssueQuestionIds: ReadonlySet<string>;
  globallyExcludedQuestionIds: ReadonlySet<string>;
  allowPrivateSources: boolean;
}

/** Server-side where clause for the rotation question pool. */
export function buildServableQuestionWhere(
  options: BuildServableQuestionWhereOptions,
): Prisma.QuestionWhereInput {
  const {
    rotation,
    week,
    newOnlyForUserId,
    openIssueQuestionIds,
    globallyExcludedQuestionIds,
    allowPrivateSources,
  } = options;

  const excludedIds = new Set<string>([...openIssueQuestionIds, ...globallyExcludedQuestionIds]);

  const inner: Prisma.QuestionWhereInput = {
    rotation,
    contentState: { not: 'shelved' as const },
    NOT: { topics: { hasSome: [...EXCLUDED_POOL_TOPICS] } },
  };
  if (week !== null) inner.week = week;
  if (excludedIds.size > 0) inner.id = { notIn: [...excludedIds] };
  if (newOnlyForUserId) inner.responses = { none: { userId: newOnlyForUserId } };

  return withDefaultQuestionServingPolicy(inner, { allowPrivateSources });
}

/** Pure filter for the static rotation card list (used by the rescue path
 *  when the scheduler returns empty and we want to fall back to a non-empty
 *  pool). The caller must pass excludedCardIds that already includes the
 *  scheduler-internal exclusion union (open-issue + recent + all-time-seen
 *  for new-only). */
export interface FilterServableRotationCardListOptions {
  weekFilter: number | null;
  excludedCardIds: ReadonlySet<string>;
}

export function filterServableRotationCardList<
  T extends { id: string; week: number | null; topics?: string[] | null },
>(cardList: ReadonlyArray<T>, options: FilterServableRotationCardListOptions): T[] {
  const { weekFilter, excludedCardIds } = options;
  return cardList.filter((card) => {
    if (weekFilter !== null && card.week !== weekFilter) return false;
    if (excludedCardIds.has(card.id)) return false;
    if (
      card.topics &&
      card.topics.some((topic) => (EXCLUDED_POOL_TOPICS as readonly string[]).includes(topic))
    ) {
      return false;
    }
    return true;
  });
}
