import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { findManyCards, findManyCardProgress, ownerPrivateOrSharedCardScope } from '@/lib/cards/read-repository.server';
import { userIdCanAccessPrivateSources } from '@/lib/questions/private-access';
import { buildServableCardWhere, buildServableQuestionWhere } from './servable-pool';
import { hydrateScheduledItems, loadScheduledItemHydrationData } from './unified-session-hydration';
import { writeLiveServeDecisions } from './serve-decision-write';
import type { SessionContext } from './unified-session-types';
import type { UnifiedSessionItem } from '@/lib/knowledge/unified-scheduler';

const PAGE_SIZE = 50;
const PATH = 'fallback-never-empty';
type Candidate = UnifiedSessionItem & { linkedCardId?: string | null; linkedQuestionId?: string | null };
const candidate = (id: string, type: 'card' | 'question'): UnifiedSessionItem => ({
  type, id, conceptId: '', conceptName: '', priority: 0, interventionReason: 'weak_recall',
});

/**
 * Last resort only: soft due/daily/novelty/delivery caps cannot end review.
 * Current content, ownership, flags and the immediate/client repetition guard
 * remain hard. Each query is a bounded page; stop at the first deliverable batch.
 * fallbackRotations must be server-authorized active decks, never source grants.
 */
export async function unifiedSessionNeverEmpty(
  ctx: SessionContext,
  priorEmptyReason: string,
  fallbackRotations: readonly string[] = [],
): Promise<NextResponse> {
  if (ctx.isGuest) {
    throw new Error('Never-empty lane requires authenticated review');
  }
  try {
    const scope = ownerPrivateOrSharedCardScope(ctx.userId);
    // Two bounded last-answer reads, not a history aggregation. A stale/missing
    // client exclusion list must never reoffer the item just answered.
    const [lastCard, lastQuestion, allowPrivateSources] = await Promise.all([
      prisma.cardProgress.findFirst({
        where: { userId: ctx.userId, lastReview: { not: null } },
        orderBy: { lastReview: 'desc' }, select: { cardId: true, lastReview: true },
      }),
      prisma.questionResponse.findFirst({
        where: { userId: ctx.userId }, orderBy: { createdAt: 'desc' },
        select: { questionId: true, createdAt: true },
      }),
      userIdCanAccessPrivateSources(ctx.userId),
    ]);
    const excludedCards = new Set(ctx.clientExcludeCards);
    const excludedQuestions = new Set(ctx.clientExcludeQuestions);
    if (lastCard?.lastReview && (!lastQuestion || lastCard.lastReview >= lastQuestion.createdAt)) {
      excludedCards.add(lastCard.cardId);
    }
    if (lastQuestion && (!lastCard?.lastReview || lastQuestion.createdAt >= lastCard.lastReview)) {
      excludedQuestions.add(lastQuestion.questionId);
    }
    const batchSize = Math.max(1, Math.min(100, ctx.batchSize || 1));
    let preparationFailed = false;
    let candidateCount = 0;
    const rotations = [...new Set([ctx.rotation, ...fallbackRotations])];
    for (const rotation of rotations) {
      // Exhaust the preferred week/lane before arriving here. Hydration must
      // use the same widened rotation scope as these fallback queries.
      const rotationCtx: SessionContext = {
        ...ctx, rotation, weekFilter: null, crossSourceRotations: [],
        presentationPrepReoffer: null, automaticPrepWeek: false,
      };
      const cardWhere: Prisma.CardWhereInput = { AND: [
        buildServableCardWhere({ rotation, week: null, openIssueCardIds: new Set(),
          practiceLocale: ctx.practiceLocale, isCopyrightTier: ctx.imageTier === 'copyright' }),
        { id: { notIn: [...excludedCards] } },
        { progress: { none: { userId: ctx.userId, OR: [{ flagged: true }, { suppressed: true }, { status: 'retired' }] } } },
      ] };
      const questionWhere: Prisma.QuestionWhereInput = { AND: [
        buildServableQuestionWhere({ rotation, week: null, openIssueQuestionIds: new Set(),
          globallyExcludedQuestionIds: excludedQuestions, allowPrivateSources,
          practiceLocale: ctx.practiceLocale, isCopyrightTier: ctx.imageTier === 'copyright' }),
        { excluded: false, contentState: { in: ['validated', 'enhanced', 'cited', 'production'] } },
        { responses: { none: { userId: ctx.userId, flagged: true } } },
      ] };
      const questionPage = async (skip: number, history: Prisma.QuestionWhereInput) => (
        await prisma.question.findMany({
          where: { AND: [questionWhere, history] },
          orderBy: { id: 'asc' }, skip, take: PAGE_SIZE, select: { id: true, cardId: true },
        })
      ).map(row => ({ ...candidate(row.id, 'question'), linkedCardId: row.cardId }));
      const seen = { userId: ctx.userId };
      const unseenQuestions = async (skip: number) => (await questionPage(skip, { responses: { none: seen } }))
        .map(item => ({ ...item, firstSightAtSelection: true }));
      const missed = { ...seen, isCorrect: false, selectedOption: { not: 'SKIP' } };
      const phases: Array<(skip: number) => Promise<Candidate[]>> = [
        async skip => (await findManyCardProgress(scope, {
          where: { userId: ctx.userId, lastReview: { not: null } },
          orderBy: [{ nextDueAt: 'asc' }, { lastQuality: 'asc' }, { id: 'asc' }],
          skip, take: PAGE_SIZE, select: { cardId: true, card: { select: { question: { select: { id: true } } } } },
        }, cardWhere)).map(row => ({ ...candidate(row.cardId, 'card'), linkedQuestionId: row.card?.question?.id })),
        skip => questionPage(skip, { responses: { some: missed } }),
        skip => questionPage(skip, { AND: [{ responses: { some: seen } }, { responses: { none: missed } }] }),
        async skip => (await findManyCards(scope, {
          where: { AND: [cardWhere, { progress: { none: { userId: ctx.userId, lastReview: { not: null } } } }] },
          orderBy: { id: 'asc' }, skip, take: PAGE_SIZE, select: { id: true, question: { select: { id: true } } },
        })).map(row => ({ ...candidate(row.id, 'card'), firstSightAtSelection: true, linkedQuestionId: row.question?.id })),
        unseenQuestions,
      ];
      // Card-first novelty budgets must not hide the unseen question bank.
      // Only after that bank is exhausted may new-only relax into seen review.
      if (ctx.feedMode === 'new-only') phases.unshift(phases.pop()!);
      for (const page of phases) {
        for (let skip = 0; ; skip += PAGE_SIZE) {
          const selected = await page(skip);
          if (selected.length === 0) break;
          candidateCount += selected.length;
          // Check only this page and its linked partners; never scan all reports.
          const cardIds = selected.flatMap(item => item.type === 'card' ? [item.id] : item.linkedCardId ? [item.linkedCardId] : []);
          const questionIds = selected.flatMap(item => item.type === 'question' ? [item.id] : item.linkedQuestionId ? [item.linkedQuestionId] : []);
          const issues = await prisma.contentIssue.groupBy({
            by: ['targetType', 'targetId'],
            where: { status: { in: ['open', 'in-progress'] }, OR: [
              { targetType: 'card', targetId: { in: cardIds } },
              { targetType: 'question', targetId: { in: questionIds } },
            ] },
          });
          const blocked = new Set(issues.map(row => `${row.targetType}:${row.targetId}`));
          const safe = selected.filter(item => !blocked.has(`${item.type}:${item.id}`)
            && !blocked.has(`card:${item.linkedCardId}`) && !blocked.has(`question:${item.linkedQuestionId}`));
          const data = await loadScheduledItemHydrationData({
            userId: ctx.userId, scheduledItems: safe, deliveryContext: rotationCtx, strict: true,
          });
          const hydrated = await hydrateScheduledItems(safe, data, {
            rotation, media: ctx.media, mediaPreferences: ctx.mediaPreferences,
            onPreparationError: () => { preparationFailed = true; },
          }, null, ctx.imageTier === 'copyright' ? 'copyright-required' : 'auth-required');
          // The fallback's actual reason belongs in the audit, not the generic
          // placeholder required by the scheduler hydration type.
          const matching = hydrated.filter(item => !ctx.typeFilter || item.type === ctx.typeFilter)
            .map(item => ({ ...item, interventionReason: undefined, noveltyQuotaRequired: 0 }));
          if (matching.length > 0) {
            const fallbackReason = ctx.feedMode === 'new-only'
              ? page === unseenQuestions
                ? 'New-card lane exhausted; continuing with new questions.'
                : 'New-question lane exhausted; continuing with available review items.'
              : 'Scheduled lanes exhausted; continuing with available review items.';
            const items = await writeLiveServeDecisions(matching.slice(0, batchSize).map(item => item.imageUrl && !item.imageCaption?.trim()
              ? { ...item, imageCaption: [item.type === 'card' ? item.back : null, item.context]
                .filter((text): text is string => typeof text === 'string' && !!text.trim() && !/[<>]/.test(text))
                .join('\n\n') || 'Study image' } : item), {
              userId: ctx.userId, sessionId: ctx.sessionId, batchId: ctx.batchId,
              rotation: ctx.rotation, decisionPath: PATH, queueReason: `${priorEmptyReason}; ${fallbackReason}`,
            });
            if (items.length === 0) throw new Error('Fallback decision delivery failed');
            logger.info(PATH, { rotation: ctx.rotation, servedRotation: rotation, reason: priorEmptyReason, items: items.length });
            return NextResponse.json({ items, sessionId: ctx.sessionId, batchId: ctx.batchId,
              stats: { totalItems: items.length, version: PATH }, decisionPath: PATH, fallbackReason,
            }, { headers: { 'Cache-Control': 'private, no-store' } });
          }
          // Use the raw page length, never the number surviving hydration.
          if (selected.length < PAGE_SIZE) break;
        }
      }
    }
    if (preparationFailed) throw new Error('Remaining candidates could not be prepared');
    return NextResponse.json({ items: [], sessionId: ctx.sessionId, batchId: ctx.batchId,
      emptyReason: candidateCount > 0
        ? 'No remaining items can be shown with your current content and media settings.'
        : 'No available items remain outside your current review queue in these rotations.',
      decisionPath: PATH,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    logger.warn('Never-empty fallback unavailable', { rotation: ctx.rotation, error: String(error) });
    return NextResponse.json({ error: 'Could not prepare your next review items. Please retry.',
      code: 'session_unavailable', retryable: true,
    }, { status: 503, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '2' } });
  }
}
