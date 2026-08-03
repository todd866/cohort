/**
 * Struggle Interventions
 *
 * Detects stuck cards in a session and applies interventions:
 * scaffold (bridge cards), context (teaching content),
 * retreat (park and substitute), or continue (mark only).
 *
 * Extracted from unified-scheduler.ts for modularity.
 */

import { prisma } from '@/lib/prisma';
import { selectIntervention, type InterventionDecision } from './intervention';
import { isCardStuck, isCardChronicallyStuck, isItemAcutelyStuck } from './struggle';
import type { UnifiedSessionItem } from './unified-scheduler';

/**
 * Apply struggle interventions to stuck cards in the session.
 *
 * For each card in the session:
 * 1. Check if it's stuck (3+ fails in 24h)
 * 2. If stuck, call selectIntervention to decide what to do
 * 3. Based on strategy:
 *    - continue: keep card as-is
 *    - scaffold: insert bridge cards before the stuck card
 *    - context: mark card with context info (UI shows teaching content)
 *    - retreat: remove card (it's parked), add variant if available
 */
export async function applyStruggleInterventions(
  userId: string,
  rotation: string,
  items: UnifiedSessionItem[]
): Promise<UnifiedSessionItem[]> {
  // Detect chronically stuck MCQs (lifetime accuracy ≤30% over ≥3 attempts)
  // and inject a topic-matched bridge card before each, so the user re-
  // attempts the question after seeing related teaching content. Cards with
  // weak user mastery are explicitly excluded as bridges (see
  // findBridgeCardsForStuckMcqs below) so we don't scaffold a stuck MCQ
  // with a poorly-known card.
  const taggedItems = await tagChronicStuckMcqs(userId, items);

  // Get card IDs from the session
  const cardIds = taggedItems.filter((i) => i.type === 'card').map((i) => i.id);
  if (cardIds.length === 0) return taggedItems;

  // Batch fetch card progress to check stuck state — fetch lifetime stats
  // too so we can detect chronic stuck (failures spread across days/weeks
  // that the 24h window misses).
  const progressRecords = await prisma.cardProgress.findMany({
    where: {
      userId,
      cardId: { in: cardIds },
    },
    select: {
      cardId: true,
      recentFailCount: true,
      recentFailWindowStart: true,
      totalReviews: true,
      correctCount: true,
    },
  });

  const progressMap = new Map(progressRecords.map((p) => [p.cardId, p]));

  // Identify stuck cards. Two flavours:
  //   - Acute stuck: 3+ fails in last 24h (isCardStuck)
  //   - Chronic stuck: lifetime accuracy ≤ 30% over 3+ reviews (isCardChronicallyStuck)
  // Either condition triggers intervention. We carry an effective fail count
  // forward so the intervention log records the right severity — recentFailCount
  // is often 0 for chronic-stuck cards (24h window has long since reset), so
  // logging that would understate how stuck the card actually is.
  // Three flavours of stuck:
  //   - 24h-window stuck (isCardStuck): 3+ fails inside the rolling 24h window
  //   - Chronic stuck (isCardChronicallyStuck): ≤30% lifetime accuracy at ≥3 reviews
  //   - Acute-band stuck (isItemAcutelyStuck): <50% lifetime accuracy at ≥3 reviews
  //     (broader band — catches 31-49% which the chronic gate misses but
  //     walk-audit's no-scaffolding-on-fail still wants scaffolded).
  // All three trigger an intervention. We carry the effective fail count
  // forward so the intervention log records the right severity — the
  // 24h-window count is often 0 for items stuck across many days.
  const stuckCardIds = new Set<string>();
  const failCountForStuck = new Map<string, number>();
  for (const cardId of cardIds) {
    const progress = progressMap.get(cardId);
    if (!progress) continue;
    const windowStuck = isCardStuck(
      progress.recentFailCount,
      progress.recentFailWindowStart,
      new Date()
    ).isStuck;
    const chronicStuck = isCardChronicallyStuck(
      progress.totalReviews,
      progress.correctCount,
    );
    const acuteBandStuck = isItemAcutelyStuck(
      progress.totalReviews,
      progress.correctCount,
    );
    if (windowStuck || chronicStuck || acuteBandStuck) {
      stuckCardIds.add(cardId);
      // Use lifetime fail count when chronic/acute-band; 24h-window count when
      // only the rolling window flagged it. If both, use the larger.
      const lifetimeFails = progress.totalReviews - progress.correctCount;
      const effective = (chronicStuck || acuteBandStuck)
        ? Math.max(lifetimeFails, progress.recentFailCount)
        : progress.recentFailCount;
      failCountForStuck.set(cardId, effective);
    }
  }

  if (stuckCardIds.size === 0) return taggedItems;

  // Apply interventions to stuck cards
  const result: UnifiedSessionItem[] = [];
  const interventionPromises: Promise<InterventionDecision>[] = [];
  const stuckCardIdList = Array.from(stuckCardIds);

  // Select interventions for all stuck cards in parallel
  for (const cardId of stuckCardIdList) {
    const failCount = failCountForStuck.get(cardId) ?? 3;
    interventionPromises.push(
      selectIntervention(userId, cardId, rotation, failCount)
    );
  }

  const interventions = await Promise.all(interventionPromises);
  const interventionMap = new Map(
    stuckCardIdList.map((id, idx) => [id, interventions[idx]])
  );

  // Rebuild items list with interventions applied
  for (const item of taggedItems) {
    if (item.type !== 'card' || !stuckCardIds.has(item.id)) {
      // Not a stuck card, keep as-is
      result.push(item);
      continue;
    }

    const intervention = interventionMap.get(item.id);
    if (!intervention) {
      result.push(item);
      continue;
    }

    switch (intervention.strategy) {
      case 'continue':
        // Keep card as-is but mark with intervention info
        result.push({
          ...item,
          interventionReason: 'stuck_intervention',
          struggleIntervention: {
            strategy: 'continue',
          },
        });
        break;

      case 'scaffold':
        // Insert scaffold cards before the stuck card
        if (intervention.scaffoldCards && intervention.scaffoldCards.length > 0) {
          for (const bridgeCard of intervention.scaffoldCards) {
            result.push({
              type: 'card',
              id: bridgeCard.id,
              conceptId: item.conceptId,
              conceptName: item.conceptName,
              priority: item.priority + 0.1, // Slightly higher priority
              interventionReason: 'stuck_intervention',
              struggleIntervention: {
                strategy: 'scaffold',
                isScaffold: true,
                targetCardId: item.id,
              },
            });
          }
        }
        // Then add the original stuck card
        result.push({
          ...item,
          interventionReason: 'stuck_intervention',
          struggleIntervention: {
            strategy: 'scaffold',
          },
        });
        break;

      case 'context':
        // Mark card with context info (UI will show teaching content)
        result.push({
          ...item,
          interventionReason: 'stuck_intervention',
          struggleIntervention: {
            strategy: 'context',
          },
        });
        break;

      case 'retreat':
        // Don't add the stuck card (it's parked)
        // Add variant question if available
        if (intervention.variantQuestionId) {
          result.push({
            type: 'question',
            id: intervention.variantQuestionId,
            conceptId: item.conceptId,
            conceptName: item.conceptName,
            priority: item.priority,
            interventionReason: 'stuck_intervention',
            struggleIntervention: {
              strategy: 'retreat',
              targetCardId: item.id,
            },
          });
        }
        // Note: the stuck card is NOT added - it's parked
        break;
    }
  }

  return result;
}

/**
 * Detect chronic-stuck MCQs in the session, tag them with
 * `interventionReason: 'chronic_stuck_mcq'`, and inject one bridge
 * card on overlapping topics before each so the user sees teaching
 * content immediately before re-attempting the question.
 *
 * MCQs don't have a CardProgress equivalent, so we aggregate raw
 * QuestionResponse rows per (user, question). Lifetime accuracy
 * across all sessions = correctCount / totalAttempts.
 */
async function tagChronicStuckMcqs(
  userId: string,
  items: UnifiedSessionItem[],
): Promise<UnifiedSessionItem[]> {
  const questionIds = items.filter((i) => i.type === 'question').map((i) => i.id);
  if (questionIds.length === 0) return items;

  // Aggregate per question: count attempts and correct count.
  const attemptStats = await prisma.questionResponse.groupBy({
    by: ['questionId'],
    where: { userId, questionId: { in: questionIds } },
    _count: { _all: true },
  });
  const correctStats = await prisma.questionResponse.groupBy({
    by: ['questionId'],
    where: { userId, questionId: { in: questionIds }, isCorrect: true },
    _count: { _all: true },
  });

  const attemptMap = new Map(attemptStats.map((s) => [s.questionId, s._count._all]));
  const correctMap = new Map(correctStats.map((s) => [s.questionId, s._count._all]));

  // Tag both chronic-stuck (≤30% accuracy) AND acute-band-stuck (<50%)
  // MCQs. The broader acute band is what walk-audit's no-scaffolding-on-fail
  // pathology actually fires on — items the user keeps missing but with not
  // *quite* low enough lifetime accuracy to qualify as chronic.
  const chronicStuckQuestionIds = new Set<string>();
  for (const qid of questionIds) {
    const attempts = attemptMap.get(qid) ?? 0;
    const correct = correctMap.get(qid) ?? 0;
    if (isItemChronicallyStuck(attempts, correct) || isItemAcutelyStuck(attempts, correct)) {
      chronicStuckQuestionIds.add(qid);
    }
  }

  if (chronicStuckQuestionIds.size === 0) return items;

  // For each chronic-stuck MCQ find ONE bridge card on the same topics
  // that the user has done well on. Insert it directly before the MCQ
  // so the user sees the teaching content immediately before re-attempting.
  const bridgeMap = await findBridgeCardsForStuckMcqs(
    userId,
    Array.from(chronicStuckQuestionIds),
  );

  // Rebuild the items list, intercalating bridge cards before stuck MCQs.
  const out: UnifiedSessionItem[] = [];
  const seenBridges = new Set<string>();
  for (const it of items) {
    if (it.type === 'question' && chronicStuckQuestionIds.has(it.id)) {
      const bridgeCardId = bridgeMap.get(it.id);
      if (bridgeCardId && !seenBridges.has(bridgeCardId)) {
        out.push({
          type: 'card',
          id: bridgeCardId,
          conceptId: it.conceptId,
          conceptName: it.conceptName,
          priority: it.priority + 0.1,
          interventionReason: 'mcq_bridge_card',
          struggleIntervention: {
            strategy: 'scaffold',
            isScaffold: true,
            targetCardId: it.id, // re-using targetCardId field; the "target" is the stuck MCQ
          },
        });
        seenBridges.add(bridgeCardId);
      }
      out.push({ ...it, interventionReason: 'chronic_stuck_mcq' });
    } else {
      out.push(it);
    }
  }
  return out;
}

/**
 * For each chronic-stuck MCQ, find one bridge card on overlapping topics
 * that the user has shown competence on (mastered status preferred,
 * else any card with ≥1 successful review). Returns a map questionId →
 * bridge cardId for the cards we want to insert.
 *
 * We do this per-question rather than as one bulk query to keep the
 * matched bridge specific to each stuck MCQ; this stays cheap because
 * most sessions have ≤2 stuck MCQs and we only fetch top-1 per query.
 */
async function findBridgeCardsForStuckMcqs(
  userId: string,
  stuckQuestionIds: string[],
): Promise<Map<string, string>> {
  if (stuckQuestionIds.length === 0) return new Map();

  // Get the topics + rotation for each stuck question.
  const questions = await prisma.question.findMany({
    where: { id: { in: stuckQuestionIds } },
    select: { id: true, topics: true, rotation: true },
  });

  const result = new Map<string, string>();
  const usedBridges = new Set<string>();
  for (const q of questions) {
    if (q.topics.length === 0) continue;

    // First-choice bridge: a teaching card on overlapping topics that
    // the user has demonstrated genuine competence on. NOT just
    // "correctCount > 0" — a card with 1 correct out of 10 reviews is
    // exactly the kind of poorly-known item we should not use as
    // scaffolding for another stuck item. Require either:
    //   - status = 'mastered', OR
    //   - status = 'reviewing' AND retrievalStrength ≥ 0.7
    // Both excludes 'learning' (still acquiring) and any low-strength
    // 'reviewing' card that hasn't actually stuck.
    let candidates = await prisma.card.findMany({
      where: {
        rotation: q.rotation,
        deletedAt: null,
        topics: { hasSome: q.topics },
        id: { notIn: Array.from(usedBridges) },
        progress: {
          some: {
            userId,
            OR: [
              { status: 'mastered' },
              { status: 'reviewing', retrievalStrength: { gte: 0.7 } },
            ],
          },
        },
      },
      select: { id: true },
      orderBy: [{ feedScore: 'desc' }],
      take: 1,
    });

    // Fallback: any teaching card on overlapping topics, even one the
    // user hasn't seen yet. A fresh KeyPoint that explains the relevant
    // concept is still better priming than no scaffolding at all.
    if (candidates.length === 0) {
      candidates = await prisma.card.findMany({
        where: {
          rotation: q.rotation,
          deletedAt: null,
          topics: { hasSome: q.topics },
          id: { notIn: Array.from(usedBridges) },
          sourceComponent: 'KeyPoint',
        },
        select: { id: true },
        orderBy: [{ feedScore: 'desc' }],
        take: 1,
      });
    }

    if (candidates.length > 0) {
      result.set(q.id, candidates[0].id);
      usedBridges.add(candidates[0].id);
    }
  }
  return result;
}

/**
 * Same threshold as cards: ≥3 attempts at ≤30% lifetime accuracy.
 * Re-uses the card constants so cards and questions stay calibrated together.
 * Re-exported for tests so the test file can assert against the same numbers.
 */
function isItemChronicallyStuck(totalAttempts: number, correctCount: number): boolean {
  return isCardChronicallyStuck(totalAttempts, correctCount);
}
