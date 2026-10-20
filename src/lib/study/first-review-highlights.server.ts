import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { ANSWER_EVENT_TYPES } from '@/lib/learning/event-taxonomy';
import { findManyCards, SHARED_CATALOG_CARD_SCOPE } from '@/lib/cards/read-repository.server';
import { userIdCanAccessRequestedRotations } from '@/lib/personal-rotation-access';
import { itemImageIsPrompt } from '@/lib/figures/prompt-policy';
import { buildServableCardWhere, buildServableQuestionWhere, loadServablePoolFilters } from './servable-pool';
import { hydrateScheduledItems, loadScheduledItemHydrationData } from './unified-session-hydration';
import { filterCardsAtDueEgress, logExposures } from './unified-session-helpers';
import { writeLiveServeDecisions } from './serve-decision-write';
import type { UnifiedSessionItem } from '@/lib/knowledge/unified-scheduler-types';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import { FIRST_REVIEW_CATALOG } from './first-review-catalog';
import { FIRST_REVIEW_ROTATIONS, orderFirstReviewHighlights } from './first-review-highlights';

import { DISCOVERY_LIMIT, DISCOVERY_WINDOW_MS, discoveryBudget, discoveryBatchCapacity, discoveryGoal, discoveryPreferenceScore, discoveryRotationNeeds } from './discovery';

/** Bounded first-day discovery: at most 24 evidence rows, never a corpus/history scan.
 * Old identities return from the existing auth snapshot (guests use one PK read).
 * Failure keeps ordinary review. */
export async function tryFirstReviewHighlights(
  ctx: SessionContext,
  explicitFocus: boolean,
  knownUser?: { createdAt: Date; activeModules: string[]; track: number | null; feedProfile?: unknown },
): Promise<NextResponse | null> {
  if (!(FIRST_REVIEW_ROTATIONS as readonly string[]).includes(ctx.rotation)
    || ctx.publicSurface === 'cohort' || ctx.media || ctx.typeFilter || ctx.weekFilter !== null
    || ctx.difficultyFilter || ctx.topicsFilter || ctx.clusterFilter || ctx.modulesFilter
    || ctx.mode || ctx.requestedMode || ctx.reviewFilter || ctx.feedMode || ctx.noCache
    || ctx.reviewChallenge?.level || ctx.practiceReviewFocus?.weakTopics.length
    || (ctx.examTarget && ctx.examTarget.resolved.effectiveMode !== 'off')) return null;
  try {
    const user = knownUser ?? await prisma.user.findUnique({
      where: { id: ctx.userId }, select: { createdAt: true, activeModules: true, track: true, feedProfile: true },
    });
    if (!user || Date.now() - user.createdAt.getTime() >= DISCOVERY_WINDOW_MS) return null;
    const goal = discoveryGoal(user.feedProfile);
    if (goal.skipped) return null;
    const completed = await prisma.learningEvent.findMany({
      where: { userId: ctx.userId, eventType: { in: [...ANSWER_EVENT_TYPES, 'video_watched'] } },
      select: { id: true, sourceId: true, eventType: true, rotation: true, quality: true, isCorrect: true, metadata: true, timestamp: true },
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }], take: DISCOVERY_LIMIT,
    });
    const { remaining, adaptive } = discoveryBudget(user.createdAt, completed);
    const needs = discoveryRotationNeeds(completed);
    // Short later batches let real answers steer the next selection. No synthetic grades.
    const capacity = discoveryBatchCapacity(adaptive, completed.length, remaining,
      ctx.clientExcludeCardSet.size + ctx.clientExcludeQuestionSet.size, ctx.batchSize);
    if (capacity <= 0) return null;
    const goalRotation = (FIRST_REVIEW_ROTATIONS as readonly string[]).includes(goal.choice ?? '') ? goal.choice : undefined;
    const chosenRotation = !explicitFocus && goalRotation ? goalRotation : ctx.rotation;
    const explore = !explicitFocus && !goalRotation && (goal.choice === 'explore' || (!user.track && user.activeModules.length === 0));
    const catalog = FIRST_REVIEW_CATALOG.filter(entry => explore || entry.rotation === chosenRotation);
    const rotations = [...new Set(catalog.map(entry => entry.rotation))];
    const filters = await loadServablePoolFilters(ctx.userId);
    const trust = ctx.imageTier === 'copyright' ? 'copyright-required' : ctx.isGuest ? 'public' : 'auth-required';
    const excluded = new Set([...ctx.clientExcludeCardSet, ...ctx.clientExcludeQuestionSet]);
    const candidates = (await Promise.all(rotations.map(async rotation => {
      if (!await userIdCanAccessRequestedRotations(ctx.userId, [rotation])) return [];
      const entries = catalog.filter(entry => entry.rotation === rotation);
      const cardEntries = entries.filter(entry => entry.type === 'card');
      const questionEntries = entries.filter(entry => entry.type === 'question');
      const [cards, questions] = await Promise.all([
        cardEntries.length ? findManyCards(SHARED_CATALOG_CARD_SCOPE, {
          where: { AND: [buildServableCardWhere({ rotation, week: null, newOnlyForUserId: ctx.userId, openIssueCardIds: filters.openIssueCardIds,
            practiceLocale: ctx.practiceLocale, isCopyrightTier: ctx.imageTier === 'copyright' }),
          { stableId: { in: cardEntries.map(entry => entry.key) } }] },
          select: { id: true, stableId: true, imageUrl: true, clipId: true, conceptId: true },
        }) : [],
        questionEntries.length ? prisma.question.findMany({
          where: { AND: [buildServableQuestionWhere({ rotation, week: null, newOnlyForUserId: ctx.userId, ...filters,
            practiceLocale: ctx.practiceLocale, isCopyrightTier: ctx.imageTier === 'copyright' }),
          { id: { in: questionEntries.map(entry => entry.key) } }] },
          select: { id: true, imageUrl: true, clipId: true, concepts: { where: { isPrimary: true }, take: 1, select: { conceptId: true } } },
        }) : [],
      ]);
      const matched = entries.flatMap(entry => {
        const row = entry.type === 'card' ? cards.find(card => card.stableId === entry.key)
          : questions.find(question => question.id === entry.key);
        if (!row || excluded.has(row.id) || (row.clipId ?? row.imageUrl) !== entry.media) return [];
        const conceptId = 'conceptId' in row ? row.conceptId : 'concepts' in row ? row.concepts[0]?.conceptId : '';
        return [{ entry, id: row.id, conceptId: conceptId ?? '' }];
      });
      const scheduled: UnifiedSessionItem[] = matched.map(({ entry, id, conceptId }) => ({
        type: entry.type, id, conceptId, conceptName: '', priority: 1, interventionReason: 'pre_teach',
      }));
      const hydration = await loadScheduledItemHydrationData({
        userId: ctx.userId, scheduledItems: scheduled,
        deliveryContext: { userId: ctx.userId, rotation, practiceLocale: ctx.practiceLocale, weekFilter: null },
      });
      const hydrated = await hydrateScheduledItems(scheduled, hydration, { rotation }, null, trust);
      return hydrated.flatMap(item => {
        const entry = matched.find(candidate => candidate.id === item.id)?.entry;
        // Current-body hydration may have raced an attachment edit. Pin it again.
        if (!entry || (item.clip?.id ?? item.imageKey) !== entry.media || (!item.clip?.url && !item.imageUrl)
          || (item.imageMeta?.revealImageKey && item.imageMeta.revealImageKey !== entry.media)) return [];
        const pinnedMedia = item.clip ? { imageUrl: null, imageKey: null, imageCaption: null, imageMeta: undefined } : {};
        return [{ ...item, ...pinnedMedia, imageAlternatives: [], mediaKey: entry.media, kind: entry.kind,
          diagnosticScore: (needs.get(item.rotation) ?? 0) + discoveryPreferenceScore({ ...item, kind: entry.kind }, user.feedProfile),
          video: Boolean(item.clip?.url), prompt: (item.clipRole === 'prompt' && Boolean(item.clip?.url)) || itemImageIsPrompt(item.imageRole, item.imageMeta, item.front ?? item.stem) }];
      });
    }))).flat();
    const due = await filterCardsAtDueEgress(candidates, {
      userId: ctx.userId, rotation: ctx.rotation, path: 'first-review', isGuest: ctx.isGuest,
    });
    const eligible = candidates.filter(item => item.type !== 'card' || due.eligibleCardIds.has(item.id));
    const selected = orderFirstReviewHighlights(eligible, ctx.sessionId, capacity, adaptive && (completed.length >= 6 || Boolean(goal.choice || goal.text)));
    if (!selected.length) return null;
    const items: UnifiedItem[] = selected.map(candidate => {
      const { mediaKey, kind, prompt, video, diagnosticScore, ...item } = candidate;
      void mediaKey; void kind; void prompt; void video; void diagnosticScore;
      return { ...item, servedBy: 'starter', firstSightAtSelection: true,
        decisionContext: { servedBy: 'starter', sessionType: 'review', sessionId: ctx.sessionId,
          embeddingType: 'none', firstReview: true, firstReviewExplore: explore, ...(adaptive ? { firstReviewVersion: 2, firstReviewStartedAt: user.createdAt.toISOString(), firstReviewCompleted: completed.length } : {}) },
      };
    });
    const delivered: UnifiedItem[] = [];
    for (const rotation of new Set(items.map(item => item.rotation))) {
      delivered.push(...await writeLiveServeDecisions(items.filter(item => item.rotation === rotation), {
        userId: ctx.userId, sessionId: ctx.sessionId, batchId: ctx.batchId, rotation,
        decisionPath: 'first-review', queueReason: 'first_review_highlight',
      }));
    }
    const byId = new Map(delivered.map(item => [item.id, item]));
    const ordered = items.map(item => byId.get(item.id) ?? item);
    for (const rotation of new Set(ordered.map(item => item.rotation))) {
      logExposures(ordered.filter(item => item.rotation === rotation), {
        userId: ctx.userId, rotation, queueType: 'first_review_highlight', batchId: ctx.batchId,
        sessionId: ctx.sessionId, anonymousSessionId: ctx.anonymousSessionId, cardDueAudit: due.audit,
      });
    }
    return NextResponse.json({ items: ordered, sessionId: ctx.sessionId, batchId: ctx.batchId,
      stats: { totalItems: ordered.length, version: 'first-review', composition: {
        cards: ordered.filter(item => item.type === 'card').length, questions: ordered.filter(item => item.type === 'question').length,
        groups: 0, snippets: 0,
      } }, availableFilters: { types: [], difficulties: [], topics: [] },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    logger.warn('First-review highlights unavailable; using ordinary review', { error: String(error) });
    return null;
  }
}
