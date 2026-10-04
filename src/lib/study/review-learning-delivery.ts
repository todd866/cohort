import { after, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getOpenIssueExclusions } from '@/lib/content-quality/open-issue-exclusions';
import { getExcludedQuestionIds } from '@/lib/question-bank';
import { userIdCanAccessPrivateSources } from '@/lib/questions/private-access';
import { buildServableQuestionWhere } from './servable-pool';
import { itemMatchesReviewLearning } from './review-learning-item';
import { getReviewLearningGap, type ReviewLearningGap } from './review-learning-gap.server';
import { recordReviewChallengeDemand, DEFAULT_REVIEW_CHALLENGE_RUNWAY } from './review-challenge-demand';
import type { SessionContext, UnifiedItem } from './unified-session-types';

/** BACKGROUND ONLY. Count fresh supply by concept, without mistaking cooldowns for missing content. */
export async function recordExhaustedHardRunway(ctx: SessionContext, gap: ReviewLearningGap): Promise<void> {
  if (!gap.available || gap.conceptIds.size === 0) return;
  try {
    // These reads intentionally throw on failure: unknown supply is never zero.
    const [issues, excluded, allowPrivateSources] = await Promise.all([
      getOpenIssueExclusions(), getExcludedQuestionIds(), userIdCanAccessPrivateSources(ctx.userId),
    ]);
    const candidates = await prisma.question.findMany({
      where: { AND: [
        buildServableQuestionWhere({
          rotation: ctx.rotation, week: null, newOnlyForUserId: ctx.userId,
          openIssueQuestionIds: issues.questionIds, globallyExcludedQuestionIds: excluded,
          allowPrivateSources, practiceLocale: ctx.practiceLocale,
          isCopyrightTier: ctx.imageTier === 'copyright',
        }),
        { difficulty: 'hard', concepts: { some: { conceptId: { in: [...gap.conceptIds] } } } },
      ] },
      select: { id: true, concepts: { select: { conceptId: true } } },
    });
    const delivered = candidates.length ? await prisma.serveDecision.findMany({
      where: { userId: ctx.userId, itemType: 'question', itemId: { in: candidates.map(item => item.id) }, OR: [{ deliveryPath: { not: null } }, { exposedAt: { not: null } }] },
      select: { itemId: true }, distinct: ['itemId'],
    }) : [];
    const seen = new Set(delivered.map(item => item.itemId));
    const counts = new Map<string, number>();
    for (const question of candidates) {
      if (seen.has(question.id)) continue;
      for (const { conceptId } of question.concepts) {
        if (gap.conceptIds.has(conceptId)) counts.set(conceptId, (counts.get(conceptId) ?? 0) + 1);
      }
    }
    // This is content supply, not today's scheduler ranking: instant review can
    // deliver unembedded questions. Cooldowns/top-K are temporary selection
    // constraints and must not trigger duplicate authoring of an existing bank.
    // Concept evidence is bounded by the loader. Each concept receives its own
    // actual supply, never the rotation total copied into unrelated demands.
    for (const conceptId of gap.conceptIds) {
      const supply = counts.get(conceptId) ?? 0;
      if (supply >= DEFAULT_REVIEW_CHALLENGE_RUNWAY) continue;
      await recordReviewChallengeDemand({
        userId: ctx.userId, rotation: ctx.rotation, challengeLevel: 2,
        knownGapConceptIds: [conceptId], eligibleHardUnseenCount: supply,
        reason: 'hardest-review-exhausted',
      });
    }
  } catch (error) {
    logger.warn('Hard review demand could not be measured', { rotation: ctx.rotation, error: String(error) });
  }
}

/** Enforce endpoints after every injector; only successful empty builds can request easing. */
export async function withReviewLearningPolicy(response: NextResponse, ctx: SessionContext): Promise<NextResponse> {
  const level = ctx.reviewChallenge?.level ?? 0;
  if (response.status !== 200 || (level !== 2 && level !== -2)) return response;
  const payload = await response.clone().json().catch(() => null);
  if (!payload || !Array.isArray(payload.items)) return response;
  const gap = level === 2 ? await getReviewLearningGap(ctx) : null;
  if (gap && !gap.available) {
    return NextResponse.json({ error: 'Could not check your learning gaps. Please retry.', code: 'session_unavailable' }, { status: 503 });
  }
  const items = (payload.items as UnifiedItem[]).filter(item => itemMatchesReviewLearning(item, level, gap?.questionIds));
  const removed = payload.items.length - items.length;
  if (removed > 0) logger.error('Review difficulty boundary removed ineligible items', { rotation: ctx.rotation, level, removed });
  // A filtered invalid batch is a delivery defect, not proof that the bank ran out.
  if (removed > 0 && items.length === 0) {
    return NextResponse.json({ error: 'Could not prepare matching questions. Please retry.', code: 'session_unavailable' }, { status: 503 });
  }
  // With no demonstrated gaps the requested lane is also unavailable: ease
  // without inventing authoring demand for an untested topic.
  const exhausted = level === 2 && payload.items.length === 0 && gap?.available === true && !ctx.isGuest;
  if (exhausted) after(() => recordExhaustedHardRunway(ctx, gap));
  if (removed === 0 && !exhausted) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json({ ...payload, items,
    ...(exhausted ? { reviewChallengeExhausted: ctx.reviewChallenge } : {}),
  }, { status: response.status, headers });
}
