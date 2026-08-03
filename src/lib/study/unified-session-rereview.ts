import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';
import { shuffle } from '@/lib/utils/shuffle';
import { getStudyDayStart } from '@/lib/study-day';
import type { SessionContext } from './unified-session-types';
import { enrichItemsWithWalkMetadata } from '@/lib/audit/walk-metadata';
import { scoreOrderedPairwiseDistances } from '@/lib/manifold/scoring';
import { logExposures } from './unified-session-helpers';
import { resolveImage } from '@/lib/figures/resolve';
import { logger } from '@/lib/logger';
import { writeLiveServeDecisions } from './serve-decision-write';

export const REREVIEW_COOLDOWN_MS = 45 * 60 * 1000;
export const REREVIEW_DAILY_VIEW_CAP = 2;

/**
 * Rereview path: returns cards the user got wrong today.
 *
 * Fast query — no manifold, no scheduler. Just finds CardProgress rows
 * where lastReview >= startOfDay and lastQuality <= 2 (got it wrong),
 * excludes cards still inside their cool-down / daily view cap, hydrates the
 * cards, shuffles, and returns.
 *
 * Returns null if mode !== 'rereview' or no wrong cards found.
 */
export async function tryRereviewSession(ctx: SessionContext): Promise<NextResponse | null> {
  if (ctx.mode !== 'rereview') return null;
  if (ctx.isGuest) return NextResponse.json({ items: [], sessionId: ctx.sessionId, batchId: ctx.batchId });

  const now = new Date();
  const startOfDay = getStudyDayStart(now);
  const cooldownCutoff = new Date(now.getTime() - REREVIEW_COOLDOWN_MS);

  // Serve-time recency exclusion. The lastReview / viewsToday gates below are
  // keyed on ANSWER time and answer count (both only update when the user grades
  // a card), so between the 1st and 2nd answer a wrong-today card re-qualifies on
  // every batch fetch and churns back within minutes. Gate on actual serve
  // exposures (content_exposed / card_reviewed within the 45-min cooldown) so a
  // card served recently is held out until the spacing interval passes — this is
  // the serve-recency guard the cache path already applies, missing here.
  const recentlyServed = await prisma.learningEvent.findMany({
    where: {
      userId: ctx.userId,
      sourceType: 'card',
      eventType: { in: ['content_exposed', 'card_reviewed'] },
      timestamp: { gte: cooldownCutoff },
    },
    select: { sourceId: true },
  });
  const excludeCardIds = new Set<string>([
    ...ctx.clientExcludeCardSet,
    ...recentlyServed.map((event) => event.sourceId),
  ]);

  // Find cards the user got wrong today in this rotation
  const wrongToday = await prisma.cardProgress.findMany({
    where: {
      userId: ctx.userId,
      lastReview: { gte: startOfDay, lte: cooldownCutoff },
      lastQuality: { lte: 2 },
      OR: [
        { viewsTodayDate: null },
        { viewsTodayDate: { lt: startOfDay } },
        { viewsToday: { lt: REREVIEW_DAILY_VIEW_CAP } },
      ],
      card: {
        rotation: ctx.rotation,
        deletedAt: null,
        shelvedAt: null,
      },
      // Exclude cards already in the current session AND any served in the last
      // 45 min (serve-recency), so a wrong-today card is not re-served as churn.
      ...(excludeCardIds.size > 0
        ? { cardId: { notIn: [...excludeCardIds] } }
        : {}),
    },
    select: {
      card: {
        select: {
          id: true,
          front: true,
          back: true,
          backs: true,
          context: true,
          sourceComponent: true,
          rotation: true,
          week: true,
          difficulty: true,
          topics: true,
          imageUrl: true,
          imageCaption: true,
          imageRole: true,
          clusterId: true,
        },
      },
    },
    take: ctx.batchSize,
  });

  if (wrongToday.length === 0) {
    return NextResponse.json({ items: [], sessionId: ctx.sessionId, batchId: ctx.batchId });
  }

  // SQL-side similarityToPrior — no embedding bytes leave Postgres.
  const rereviewCardIds = wrongToday.map(({ card }) => card.id);
  const orderedForPairwise = rereviewCardIds.map((id) => ({
    id,
    table: 'card_embeddings' as const,
    column: 'card_id' as const,
  }));
  const similarityToPriorMap = await scoreOrderedPairwiseDistances(orderedForPairwise);

  // Resolve signed image URLs at egress — card.imageUrl from DB is the stable
  // /figures/... key, not a signed URL; pass it through resolveImage to mint
  // a fresh signed R2 URL with correct trust-gating per this user's session.
  const session = ctx.isGuest ? null : await auth();

  const rereviewItemsRaw = (await Promise.all(wrongToday.map(async ({ card }) => {
    // Mirror the instant/starter lanes: one bad sidecar must degrade that card,
    // not 500 the session.
    let resolved: Awaited<ReturnType<typeof resolveImage>> = null;
    try {
      resolved = await resolveImage(card.imageUrl ?? null, session);
    } catch (err) {
      logger.warn('rereview: card image resolve failed', { cardId: card.id, err });
    }
    // An image-as-prompt card's front IS the question; without its figure it is
    // unanswerable. Drop it rather than serve a broken card.
    if (card.imageRole === 'prompt' && !resolved) return null;
    return {
      type: 'card' as const,
      id: card.id,
      front: card.front,
      back: card.back,
      backs: card.backs as string[] | null,
      context: card.context,
      sourceComponent: card.sourceComponent ?? undefined,
      rotation: card.rotation,
      week: card.week,
      difficulty: card.difficulty ?? undefined,
      topics: card.topics,
      imageUrl: resolved?.imageUrl ?? null,
      imageKey: resolved?.imageKey ?? null,
      // The harness rule: a caption is REQUIRED whenever imageUrl is set.
      // Omitting it made every image-bearing rereview card violate the
      // served-item contract that now gates this lane.
      imageCaption: card.imageCaption ?? null,
      imageMeta: resolved?.imageMeta,
      // Top-level walk fields (Phase 1 of scheduler-walk-audit)
      servedBy: 'rereview' as const,
      clusterId: card.clusterId ?? null,
      poolSize: wrongToday.length,
      // Rereview cards were missed today (lastQuality <= 2) — the user's
      // real recall is low. 0.3 reflects that without overstating confidence;
      // the audit can flag rereview sessions whose avg recall drifts above
      // ~0.5 (the model thinks the user knows it but they kept missing it).
      predictedRecall: 0.3 as number | null,
      difficultyTier: null as 'scaffolding' | 'standard' | 'stretch' | null,
      // Existing decisionContext preserved for backward compat
      decisionContext: {
        servedBy: 'cached' as const,
        sessionType: 'review' as const,
        sessionId: ctx.sessionId,
        embeddingType: 'none' as const,
      },
    };
  }))).filter((item): item is NonNullable<typeof item> => item !== null);

  const eligibleRereviewItemsRaw = await filterDeliverableReinforcementCardRows(
    rereviewItemsRaw,
    { logContext: { path: 'rereview', userId: ctx.userId, rotation: ctx.rotation } },
  );
  const rereviewItems = enrichItemsWithWalkMetadata(
    eligibleRereviewItemsRaw,
    similarityToPriorMap,
  );

  const rereviewItemsWithDecisions = await writeLiveServeDecisions(rereviewItems, {
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    batchId: ctx.batchId,
    rotation: ctx.rotation,
    decisionPath: 'rereview',
    queueReason: 'failed-today',
  });

  // Note: positionInSession in content_exposed events reflects the
  // scheduler's intended order, not the client display order (shuffled below).
  // The scheduler's intended order for rereview is the db query order; the
  // shuffle is a UX-level change. Walk-audit consumers should treat
  // positionInSession as "scheduler rank", not "screen position".
  logExposures(rereviewItemsWithDecisions, {
    userId: ctx.userId,
    rotation: ctx.rotation,
    queueType: 'rereview',
    batchId: ctx.batchId,
    sessionId: ctx.sessionId,
    anonymousSessionId: ctx.anonymousSessionId,
    feedMode: ctx.feedMode,
  });

  const itemsForResponse = shuffle(rereviewItemsWithDecisions);

  return NextResponse.json({ items: itemsForResponse, sessionId: ctx.sessionId, batchId: ctx.batchId });
}
