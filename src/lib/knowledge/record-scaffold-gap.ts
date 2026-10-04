/**
 * Persist a preemptive-scaffold gap (from `injectPreemptiveScaffolds`) as a
 * DIAGNOSTIC ContentGap row.
 *
 * Before this, the scheduler wrote every scaffold gap with conceptId:null and
 * candidateCount:0, so 535 rows in 30d were indistinguishable — you couldn't
 * tell "no C1 teaching card exists for this topic" (a true AUTHORING gap, the
 * thing scaffold:needs should surface) from "a C1 exists but the user's unseen
 * pool didn't contain it this session" (a CONSUMPTION gap, not authoring).
 *
 * This helper populates the two discriminating fields:
 *   - conceptId      — the anchor item's concept (joinable to Concept)
 *   - candidateCount — number of complexity-1 cards in the rotation whose
 *     topics overlap the gap topics, SEEN OR UNSEEN. candidateCount === 0 ⇒
 *     true authoring gap; candidateCount > 0 ⇒ consumption gap.
 *
 * Repeats are suppressed best-effort, aiming at one row per rotation and gap a
 * day. Every scheduler pass (cron warm, request rebuild, offline pack) meets
 * the same gaps again, so writing one row and one C1 count per pass grew with
 * the learner count while the demand it measured did not. A gap is keyed by its
 * anchor concept when that is a real Concept, else by its case-insensitive
 * topic set:
 *   - this instance remembers what it recorded for 24 hours and skips repeats
 *     without touching the database;
 *   - a concept-keyed gap is also checked against the table, so an instance
 *     that has not seen it yet skips a row another instance wrote in the last
 *     24 hours. The check and the insert are separate statements with no
 *     unique constraint behind them, so two instances can still both insert;
 *   - a topic-keyed gap has no column to check, so it relies on the in-process
 *     memo alone: each instance can write its own row, and so can this one once
 *     the memo has evicted the key;
 *   - the C1 count is reused per rotation and topic set for an hour.
 * The table can therefore hold duplicates. scaffold:needs merges rows into
 * gap-days (one rotation and concept on one UTC day) rather than counting
 * them, so duplicates do not inflate its numbers.
 *
 * Fire-and-forget by contract: it never throws and never rejects — a failed
 * gap-write must not break session construction.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { ScaffoldGapRecord } from './preemptive-scaffold';
import { SCAFFOLD_GAP_TYPES } from './scaffold-gap-types';
import { persistableConceptId } from './synthetic-concept';

const SCAFFOLD_COMPLEXITY = 1;

/** Repeats of a rotation and key inside this window are skipped (best-effort; see above). */
export const SCAFFOLD_GAP_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long a C1 candidate count is reused for the same rotation and topics. */
export const SCAFFOLD_CANDIDATE_COUNT_TTL_MS = 60 * 60 * 1000;

/** Bound on each in-process memo; the oldest entry is dropped first. */
export const SCAFFOLD_GAP_MEMO_MAX_KEYS = 2_000;

/** gap key → time until which it counts as recorded */
const recordedUntil = new Map<string, number>();
/** rotation + topic set → C1 candidate count */
const candidateCounts = new Map<string, { count: number; expiresAt: number }>();

function remember<T>(memo: Map<string, T>, key: string, value: T): void {
  // Delete before setting so a refreshed key moves to the end: the Map then
  // iterates oldest first, which is the order eviction needs.
  memo.delete(key);
  memo.set(key, value);
  while (memo.size > SCAFFOLD_GAP_MEMO_MAX_KEYS) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/** Forget everything. For tests, which reuse keys with different answers. */
export function clearScaffoldGapMemos(): void {
  recordedUntil.clear();
  candidateCounts.clear();
}

/** The C1 candidate count, or null when the count failed and is unknown. */
async function candidateCountFor(rotation: string, loweredTopics: string[], now: number): Promise<number | null> {
  if (loweredTopics.length === 0) return 0;
  const key = `${rotation}\u0000${loweredTopics.join('\u001f')}`;
  const hit = candidateCounts.get(key);
  if (hit && hit.expiresAt > now) return hit.count;

  try {
    // Case-insensitive topic-ARRAY overlap, matching the live scheduler
    // (topicsOverlap is case-insensitive). Prisma `hasSome` is case-SENSITIVE,
    // so a question anchor's lowercase topic ("asthma") never matched a C1
    // card's TitleCase topic ("Asthma") — the gap was then mis-recorded as
    // authoring (candidateCount 0) when a C1 teaching card actually exists.
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM "Card"
      WHERE rotation = ${rotation}
        AND complexity = ${SCAFFOLD_COMPLEXITY}
        AND "deletedAt" IS NULL
        AND EXISTS (
          SELECT 1 FROM unnest(topics) AS ct
          WHERE lower(ct) = ANY(${loweredTopics}::text[])
        )
    `;
    const count = Number(rows[0]?.count ?? 0);
    remember(candidateCounts, key, { count, expiresAt: now + SCAFFOLD_CANDIDATE_COUNT_TTL_MS });
    return count;
  } catch (err) {
    // Unknown, not zero: candidateCount 0 is the authoring signal ("no C1
    // card exists, write one"), so the caller records nothing rather than
    // turn a failed count into authoring demand. Not remembered, so the next
    // pass that meets these topics counts again.
    logger.error('recordScaffoldGap: candidate count failed; gap not recorded', {
      rotation,
      topics: loweredTopics,
      error: String(err),
    });
    return null;
  }
}

export async function recordScaffoldGap(gap: ScaffoldGapRecord): Promise<void> {
  try {
    const now = Date.now();
    // The anchor's conceptId may be a scheduler-internal grouping key
    // (`question:<id>`, `rotation:<id>`, `_unattached`) with no Concept row
    // behind it. Writing one here threw ContentGap_conceptId_fkey and the
    // catch below swallowed it — so the ENTIRE gap was lost, not just its
    // concept link, and scaffold demand for those items never surfaced in
    // `scaffold:needs`. Null is also the honest value: an unattached anchor
    // genuinely has no concept.
    const conceptId = persistableConceptId(gap.anchorConceptId);
    const loweredTopics = [...new Set(gap.topics.map((topic) => topic.toLowerCase()))].sort();
    const gapKey = `${gap.rotation}\u0000${conceptId === null
      ? `topics:${loweredTopics.join('\u001f')}`
      : `concept:${conceptId}`}`;

    if ((recordedUntil.get(gapKey) ?? 0) > now) return;

    if (conceptId !== null) {
      const existing = await prisma.contentGap.findFirst({
        where: {
          rotation: gap.rotation,
          gapType: SCAFFOLD_GAP_TYPES.scheduler,
          conceptId,
          resolvedAt: null,
          detectedAt: { gte: new Date(now - SCAFFOLD_GAP_DEDUPE_WINDOW_MS) },
        },
        select: { detectedAt: true },
      });
      if (existing) {
        remember(recordedUntil, gapKey, existing.detectedAt.getTime() + SCAFFOLD_GAP_DEDUPE_WINDOW_MS);
        return;
      }
    }

    const candidateCount = await candidateCountFor(gap.rotation, loweredTopics, now);
    // A failed count was logged; skip without remembering, so a later pass retries.
    if (candidateCount === null) return;
    await prisma.contentGap.create({
      data: {
        rotation: gap.rotation,
        gapType: SCAFFOLD_GAP_TYPES.scheduler,
        nearestSimilarity: 0,
        candidateCount,
        conceptId,
      },
    });
    remember(recordedUntil, gapKey, now + SCAFFOLD_GAP_DEDUPE_WINDOW_MS);
  } catch (err) {
    logger.error('recordScaffoldGap: failed to record gap', {
      rotation: gap.rotation,
      topics: gap.topics,
      anchorItemId: gap.anchorItemId,
      error: String(err),
    });
  }
}
