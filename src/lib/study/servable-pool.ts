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
import {
  practiceLocaleWhere,
  type PracticeLocale,
} from '@/lib/study/practice-locale';

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
/**
 * Source corpora whose cards may be promoted onto another rotation's concepts,
 * and which are licensed material wherever they appear. Kept next to the pool
 * builder so adding one is visibly an access decision.
 */
export const PROMOTABLE_SOURCE_ROTATIONS: readonly string[] = Object.freeze(['anking', 'malleus']);

export function imagePromptCardWhere(isCopyrightTier: boolean): Prisma.CardWhereInput {
  return isCopyrightTier ? {} : {
    OR: [
      { imageRole: null },
      { imageRole: { not: 'prompt' } },
    ],
  };
}

/**
 * Clip-as-prompt items (`clipRole === 'prompt'`) are the operative-video twin of
 * image-as-prompt cards: the 6-10s clip IS the stem, so without it the card is
 * unanswerable. Clips are cut from copyrighted operative video and served from
 * the private bucket, so they reach copyright-tier users only.
 *
 * The OR is required for the same reason it is on `imagePromptCardWhere`: Prisma
 * renders a scalar `not` as SQL `<>`, and `NULL <> 'prompt'` is UNKNOWN rather
 * than true, which would quietly drop every ordinary null-role card from the
 * pool. Spread this as a sibling key into a card where-clause.
 */
export function clipPromptCardWhere(isCopyrightTier: boolean): Prisma.CardWhereInput {
  return isCopyrightTier ? {} : {
    OR: [
      { clipRole: null },
      { clipRole: { not: 'prompt' } },
    ],
  };
}

/** Question-side twin of {@link clipPromptCardWhere} — the next-step MCQ case. */
export function clipPromptQuestionWhere(isCopyrightTier: boolean): Prisma.QuestionWhereInput {
  return isCopyrightTier ? {} : {
    OR: [
      { clipRole: null },
      { clipRole: { not: 'prompt' } },
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
  /** When set, only universal + matching practice-locale twins. */
  practiceLocale?: PracticeLocale;
  /**
   * When set, narrow to one manifold cluster — the scope a square on the
   * profile knowledge heatmap promises. Narrowing only; it can never widen the
   * pool beyond the rotation above it.
   */
  cluster?: string | null;
  /**
   * Admit copyright-tier promoted rungs from restricted source corpora. The
   * CALLER decides the tier; this only shapes the query. Defaults false so a
   * call site that has not thought about rights gets the native pool.
   */
  includePromotedRungs?: boolean;
}

/** Server-side where clause for the rotation card pool. */
export function buildServableCardWhere(options: BuildServableCardWhereOptions): Prisma.CardWhereInput {
  const {
    rotation, week, newOnlyForUserId, openIssueCardIds, practiceLocale, cluster,
    includePromotedRungs = false,
  } = options;
  const where: Prisma.CardWhereInput = {
    deletedAt: null,
    shelvedAt: null,
    NOT: EXCLUDED_TOPICS_NOT,
  };
  // Promoted rungs are admitted CARD BY CARD, never deck by deck.
  //
  // Requested 2026-09-14: harder questions from the imported decks, copyright
  // tier only. The obvious implementation is to add those decks to the
  // cross-source entitlement list, and it is wrong: that grants an entire deck
  // of tens of thousands of cards to anyone it admits, and the same learners
  // were deliberately left unenrolled in those decks. The distinction that
  // matters is a DECK grant versus a CONTENT grant.
  //
  // Requiring `moduleNodes has rotation` means a restricted card reaches this
  // pool only because it was explicitly promoted onto this rotation's concepts.
  // An un-promoted AnKing card cannot appear however the flag is set, so the
  // blast radius of getting the caller's tier check wrong is the reviewed set,
  // not the corpus.
  if (includePromotedRungs) {
    where.OR = [
      { rotation },
      {
        rotation: { in: [...PROMOTABLE_SOURCE_ROTATIONS] },
        // The namespaced marker, NOT the bare host slug: the Malleus import
        // stamps every card with a catch-all containing 'cah', so the bare slug
        // admitted 3,347 cards instead of the 16 reviewed ones.
        moduleNodes: { has: `hard-rung:${rotation}` },
      },
    ];
  } else {
    where.rotation = rotation;
  }
  if (week !== null) where.week = week;
  if (cluster) where.clusterId = cluster;
  if (openIssueCardIds.size > 0) where.id = { notIn: [...openIssueCardIds] };
  if (newOnlyForUserId) where.progress = { none: { userId: newOnlyForUserId } };
  if (practiceLocale) {
    where.AND = [practiceLocaleWhere(practiceLocale)];
  }
  return where;
}

export interface BuildServableQuestionWhereOptions {
  rotation: string;
  week: number | null;
  newOnlyForUserId?: string;
  openIssueQuestionIds: ReadonlySet<string>;
  globallyExcludedQuestionIds: ReadonlySet<string>;
  allowPrivateSources: boolean;
  practiceLocale?: PracticeLocale;
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
    practiceLocale,
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
  if (practiceLocale) {
    inner.AND = [practiceLocaleWhere(practiceLocale)];
  }

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
  practiceLocale?: PracticeLocale;
}

export function filterServableRotationCardList<
  T extends {
    id: string;
    week: number | null;
    topics?: string[] | null;
    practiceLocale?: string | null;
  },
>(cardList: ReadonlyArray<T>, options: FilterServableRotationCardListOptions): T[] {
  const { weekFilter, excludedCardIds, practiceLocale } = options;
  return cardList.filter((card) => {
    if (weekFilter !== null && card.week !== weekFilter) return false;
    if (excludedCardIds.has(card.id)) return false;
    if (
      card.topics &&
      card.topics.some((topic) => (EXCLUDED_POOL_TOPICS as readonly string[]).includes(topic))
    ) {
      return false;
    }
    if (
      practiceLocale
      && card.practiceLocale != null
      && card.practiceLocale !== practiceLocale
    ) {
      return false;
    }
    return true;
  });
}
