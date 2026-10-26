import { writeLiveServeDecisions } from './serve-decision-write';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { UNIVERSAL_RECALL_OBJECTIVES } from '@/lib/review/universal-recall';
import { SHARED_CATALOG_CARD_SCOPE, findManyCards } from '@/lib/cards/read-repository.server';
import { getOpenIssueExclusions } from '@/lib/content-quality/open-issue-exclusions';
import { filterCardsAtDueEgress, logExposures } from './unified-session-helpers';
import type { SessionContext, UnifiedItem } from './unified-session-types';

/** Initial MD3 adult-resuscitation audience; persists across all four rotations. */
export function permitsUniversalRecall(ctx: SessionContext) {
  return !ctx.isGuest && ['critical-care', 'pwh', 'cah', 'paam', 'year3-common'].includes(ctx.rotation)
    && !ctx.difficultyFilter && !ctx.topicsFilter && !ctx.clusterFilter && !ctx.modulesFilter
    && !ctx.requestedMode && ctx.feedMode !== 'new-only' && !ctx.media
    && !ctx.reviewFilter && ctx.weekFilter === null && ctx.typeFilter === null;
}

export async function withUniversalRecall(response: NextResponse, ctx: SessionContext): Promise<NextResponse> {
  if (!permitsUniversalRecall(ctx) || !response.ok) return response;
  try {
    const payload = await response.clone().json();
    if (!Array.isArray(payload.items)) return response;
    const existing = payload.items as UnifiedItem[];
    const ids: string[] = UNIVERSAL_RECALL_OBJECTIVES.map(o => o.id).filter(id =>
      !ctx.clientExcludeCardSet.has(id) && !existing.some(item => item.id === id));
    if (!ids.length) return response;
    const now = new Date();
    const [cards, progress, issues, recent] = await Promise.all([
      findManyCards(SHARED_CATALOG_CARD_SCOPE, { where: {
        id: { in: ids }, rotation: 'universal-core', sourceComponent: 'UniversalRecall', deletedAt: null, shelvedAt: null,
      }, select: { id: true } }),
      prisma.cardProgress.findMany({ where: { userId: ctx.userId, cardId: { in: ids } },
        select: { cardId: true, nextDueAt: true, suppressed: true, flagged: true, status: true, leechSuppressedUntil: true, lastQuality: true } }),
      getOpenIssueExclusions(),
      // Same 24-hour card exposure window as ordinary cached review.
      prisma.learningEvent.findMany({ where: { userId: ctx.userId, sourceId: { in: ids },
        sourceType: 'card', eventType: { in: ['card_reviewed', 'content_exposed'] },
        timestamp: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      }, select: { sourceId: true } }),
    ]);
    const byId = new Map(progress.map(row => [row.cardId, row]));
    const candidates: UnifiedItem[] = cards.filter(card => {
      const row = byId.get(card.id);
      return ids.includes(card.id) && !recent.some(event => event.sourceId === card.id) && !issues.cardIds.has(card.id) && (!row || (!row.suppressed && !row.flagged
        && row.status !== 'retired' && row.nextDueAt <= now
        && (!row.leechSuppressedUntil || row.leechSuppressedUntil <= now)));
    }).sort((a, b) => (byId.get(a.id)?.lastQuality ?? -1) - (byId.get(b.id)?.lastQuality ?? -1))
      .map(card => {
        const objective = UNIVERSAL_RECALL_OBJECTIVES.find(o => o.id === card.id)!;
        return { type: 'card', id: card.id, rotation: 'universal-core', week: null,
          front: objective.prompt, back: objective.components.map(c => c.label).join('; '),
          context: 'ANZCOR 11.2 §2.9 · checked 26 Oct 2026', sourceComponent: 'UniversalRecall',
          sessionId: ctx.sessionId, batchId: ctx.batchId };
      });
    // Re-read current due state at delivery; never mark these as an intervention bypass.
    const guarded = await filterCardsAtDueEgress(candidates, { userId: ctx.userId, rotation: ctx.rotation, path: 'universal-recall', isGuest: false, checkedAt: now });
    const added = await writeLiveServeDecisions(guarded.items.slice(0, 1), {
      userId: ctx.userId, sessionId: ctx.sessionId, batchId: ctx.batchId, rotation: ctx.rotation,
      decisionPath: 'universal-recall', queueReason: 'universal-recall',
    });
    if (!added.length) return response;
    logExposures(added, { userId: ctx.userId, rotation: ctx.rotation, queueType: 'universal-recall',
      sessionId: ctx.sessionId, batchId: ctx.batchId, cardDueAudit: guarded.audit });
    // Preserve the existing hard-to-easy ordering; one bounded maintenance seat.
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('Cache-Control', 'private, no-store');
    return NextResponse.json({ ...payload, items: [...existing, ...added] }, { status: response.status, headers });
  } catch (error) {
    logger.warn('Universal recall delivery unavailable', { error: String(error) });
    return response;
  }
}
