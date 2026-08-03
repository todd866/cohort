import { NextResponse, after } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { ensureCardProgressExists } from '@/lib/stats';
import { STARTER_SESSIONS } from '@/lib/generated/starter-sessions';
import { imageKeyIsPrompt, resolveImage } from '@/lib/figures/resolve';
import { enrichItemsWithWalkMetadata } from '@/lib/audit/walk-metadata';
import {
  scoreOrderedPairwiseDistances,
  type EmbeddingItemTable,
  type EmbeddingItemIdColumn,
} from '@/lib/manifold/scoring';
import { compactMetadata } from './unified-session-helpers';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import { logSessionDiagnostic } from './unified-session-diagnostics';
import { writeLiveServeDecisions } from './serve-decision-write';
import { withoutRawPublicUsmleQuestions } from '@/lib/usmle/raw-question-boundary';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';

/**
 * Fast path: new user with zero history -> pre-built starter session.
 * Returns null if user has prior activity (falls through to next path).
 */
export async function tryStarterSession(ctx: SessionContext): Promise<NextResponse | null> {
  const starterSession = STARTER_SESSIONS[ctx.rotation];
  if (!starterSession || starterSession.items.length === 0) return null;

  // Single fast existence check — indexed on userId, <5ms
  const anyEvent = await prisma.learningEvent.findFirst({
    where: { userId: ctx.userId },
    select: { id: true },
  });
  if (anyEvent) return null;

  // SQL-side similarityToPrior: scoreOrderedPairwiseDistances returns
  // Map<itemId, similarity> in one query. No embedding bytes leave Postgres.
  const orderedForPairwise = starterSession.items.map((it) => {
    const table: EmbeddingItemTable = it.type === 'question' ? 'question_embeddings' : 'card_embeddings';
    const column: EmbeddingItemIdColumn = it.type === 'question' ? 'question_id' : 'card_id';
    return { id: it.id, table, column };
  });
  const similarityToPriorMap = await scoreOrderedPairwiseDistances(orderedForPairwise);

  // Resolve signed image URLs at egress. imageUrl in the generated starter
  // session is the stable /figures/... key; resolveImage mints a fresh signed
  // R2 URL and gates on the viewer's trust tier. Without this, the 7 restricted
  // sidecars in the generated file shipped as bare /figures/restricted/<sha>
  // keys and 404'd for every brand-new user (all standard-tier). Mirrors the
  // instant lane (fixed 2026-07-09). Guests never carry trust, so skip auth().
  const session = ctx.isGuest ? null : await auth();
  const starterItemsRaw = (await Promise.all(starterSession.items.map(async (item) => {
    // Mirror the hydration lane's resilience: one bad sidecar or signing
    // failure must degrade that item to imageless, not 500 the session.
    let resolved: Awaited<ReturnType<typeof resolveImage>> = null;
    try {
      resolved = await resolveImage(item.imageUrl ?? null, session);
    } catch (err) {
      logger.warn('starter: image resolve failed', { itemId: item.id, err });
    }
    if (item.type === 'question' && imageKeyIsPrompt(item.imageUrl) && !resolved) {
      return null;
    }
    return {
      ...item,
      imageUrl: resolved?.imageUrl ?? null,
      imageKey: resolved?.imageKey ?? null,
      imageCaption: item.imageCaption ?? null,
      imageMeta: resolved?.imageMeta,
      liked: false,
      flagged: false,
      priority: item.priority ?? 1,
      servedBy: 'starter' as const,
      clusterId: (item as { clusterId?: string | null }).clusterId ?? null,
      poolSize: starterSession.items.length,
      predictedRecall: null as number | null,
      difficultyTier: null as 'scaffolding' | 'standard' | 'stretch' | null,
      decisionContext: {
        servedBy: 'starter' as const,
        sessionType: 'review' as const,
        sessionId: ctx.sessionId,
        embeddingType: 'none' as const,
      },
    };
  }))).filter((item) => item !== null);

  // Generated starter artifacts can outlive a current cross-list membership
  // change. Revalidate every answer-bearing row immediately before delivery
  // bookkeeping/egress; lookup failure drops questions while preserving cards.
  const starterQuestionIds = starterItemsRaw
    .filter((item) => item.type === 'question')
    .map((item) => item.id);
  let eligibleStarterQuestionIds = new Set<string>();
  if (starterQuestionIds.length > 0) {
    try {
      const eligibleRows = await prisma.question.findMany({
        where: withoutRawPublicUsmleQuestions({ id: { in: starterQuestionIds } }),
        select: { id: true },
      });
      eligibleStarterQuestionIds = new Set(eligibleRows.map((question) => question.id));
    } catch (error) {
      logger.error('starter: question eligibility lookup failed; dropping questions', {
        userId: ctx.userId,
        rotation: ctx.rotation,
        error: String(error),
      });
    }
  }
  const eligibleStarterCards = await filterDeliverableReinforcementCardRows(
    starterItemsRaw.filter((item) => item.type === 'card'),
    { logContext: { path: 'starter', userId: ctx.userId, rotation: ctx.rotation } },
  );
  const eligibleStarterCardIds = new Set(eligibleStarterCards.map((card) => card.id));
  const eligibleStarterItemsRaw = starterItemsRaw.filter((item) => {
    if (item.type === 'question') return eligibleStarterQuestionIds.has(item.id);
    if (item.type === 'card') return eligibleStarterCardIds.has(item.id);
    return true;
  });
  if (starterItemsRaw.length > 0 && eligibleStarterItemsRaw.length === 0) return null;
  const starterItems = enrichItemsWithWalkMetadata(
    eligibleStarterItemsRaw.map((item) => ({
      ...item,
      poolSize: eligibleStarterItemsRaw.length,
    })),
    similarityToPriorMap,
  );

  // Persist a ServeDecision row per served item (live path) and stamp each
  // item with its serveDecisionId. The helper is fail-safe — if the DB write
  // throws we get back the original items and the response shape is preserved.
  const starterItemsWithDecisions = await writeLiveServeDecisions(starterItems as UnifiedItem[], {
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    batchId: ctx.batchId,
    rotation: ctx.rotation,
    decisionPath: 'starter',
    queueReason: 'starter_session',
  });

  // Log exposures in the background (same as normal path)
  after(async () => {
    try {
      const exposureEvents = starterItemsWithDecisions.map((item, index) => ({
        userId: ctx.userId,
        eventType: 'content_exposed',
        sourceType: item.type,
        sourceId: item.id,
        conceptIds: [],
        rotation: ctx.rotation,
        week: item.week ?? null,
        metadata: compactMetadata({
          queueReason: 'starter_session',
          queueType: 'starter',
          priority: item.priority,
          position: index,
          batchSize: starterItemsWithDecisions.length,
          batchId: ctx.batchId,
          sessionId: ctx.sessionId,
          itemType: item.type,
          conceptName: item.conceptName,
          anonymousSessionId: ctx.anonymousSessionId,
          // Walk decision context
          servedBy: item.servedBy,
          clusterId: item.clusterId,
          predictedRecall: item.predictedRecall,
          difficultyTier: item.difficultyTier,
          poolSize: item.poolSize,
          positionInSession: item.servedBy !== undefined ? (item.positionInSession ?? index) : undefined,
          similarityToPrior: item.similarityToPrior,
          // Feed-mode tag (starter sessions are by definition first-touch
          // for a brand-new user; treat as 'mixed' since the user hasn't
          // chosen new-only yet).
          feedMode: ctx.feedMode ?? 'mixed',
          // Cloze-variant group id lets walk-audit detect `variant-sibling-repeat`
          // (a regression in scheduler suppression). See @/lib/audit/walk-pathologies.
          variantGroupId: item.variantGroupId,
        }),
      }));
      await prisma.learningEvent.createMany({ data: exposureEvents });
    } catch (err) {
      logger.error('Failed to log starter session exposures', { userId: ctx.userId, rotation: ctx.rotation, error: String(err) });
    }

    // Ensure card progress exists for starter session cards
    try {
      const cardIds = starterItemsWithDecisions.filter(i => i.type === 'card').map(i => i.id);
      if (cardIds.length > 0) {
        await ensureCardProgressExists(ctx.userId, cardIds);
      }
    } catch (err) {
      logger.error('Failed to ensure starter card progress', { userId: ctx.userId, error: String(err) });
    }
  });

  const tStarterEnd = performance.now();
  const starterTiming = [
    `auth;dur=${(ctx.tAuthEnd - ctx.t0).toFixed(1)}`,
    `starter;dur=${(tStarterEnd - ctx.tAuthEnd).toFixed(1)}`,
    `total;dur=${(tStarterEnd - ctx.t0).toFixed(1)}`,
  ].join(', ');

  logSessionDiagnostic(ctx, {
    path: 'starter',
    itemCount: starterItemsWithDecisions.length,
    totalMs: +(tStarterEnd - ctx.t0).toFixed(1),
  });

  const itemsForResponse = starterItemsWithDecisions;

  return NextResponse.json({
    items: itemsForResponse,
    stats: {
      totalItems: starterItemsWithDecisions.length,
      version: 'starter',
      composition: {
        cards: starterItemsWithDecisions.filter(i => i.type === 'card').length,
        questions: starterItemsWithDecisions.filter(i => i.type === 'question').length,
        groups: 0,
        snippets: 0,
      },
    },
    availableFilters: { types: [], difficulties: [], topics: [] },
    sessionId: ctx.sessionId,
    batchId: ctx.batchId,
  }, { headers: { 'Server-Timing': starterTiming } });
}
