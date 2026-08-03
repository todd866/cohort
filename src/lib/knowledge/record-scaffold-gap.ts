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
 * Fire-and-forget by contract: it never throws and never rejects — a failed
 * gap-write must not break session construction.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { ScaffoldGapRecord } from './preemptive-scaffold';
import { persistableConceptId } from './synthetic-concept';

const SCAFFOLD_COMPLEXITY = 1;

export async function recordScaffoldGap(gap: ScaffoldGapRecord): Promise<void> {
  try {
    let candidateCount = 0;
    if (gap.topics.length > 0) {
      try {
        // Case-insensitive topic-ARRAY overlap, matching the live scheduler
        // (topicsOverlap is case-insensitive). Prisma `hasSome` is case-SENSITIVE,
        // so a question anchor's lowercase topic ("asthma") never matched a C1
        // card's TitleCase topic ("Asthma") — the gap was then mis-recorded as
        // authoring (candidateCount 0) when a C1 teaching card actually exists.
        const lowered = gap.topics.map((t) => t.toLowerCase());
        const rows = await prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM "Card"
          WHERE rotation = ${gap.rotation}
            AND complexity = ${SCAFFOLD_COMPLEXITY}
            AND "deletedAt" IS NULL
            AND EXISTS (
              SELECT 1 FROM unnest(topics) AS ct
              WHERE lower(ct) = ANY(${lowered}::text[])
            )
        `;
        candidateCount = Number(rows[0]?.count ?? 0);
      } catch (err) {
        // Count failed — still record the gap so demand surfaces, with
        // candidateCount 0 (worst case it over-reports as a true gap).
        logger.error('recordScaffoldGap: candidate count failed', {
          rotation: gap.rotation,
          topics: gap.topics,
          error: String(err),
        });
      }
    }

    await prisma.contentGap.create({
      data: {
        rotation: gap.rotation,
        gapType: 'scaffold_gap',
        nearestSimilarity: 0,
        candidateCount,
        // The anchor's conceptId may be a scheduler-internal grouping key
        // (`question:<id>`, `rotation:<id>`, `_unattached`) with no Concept row
        // behind it. Writing one here threw ContentGap_conceptId_fkey and the
        // catch below swallowed it — so the ENTIRE gap was lost, not just its
        // concept link, and scaffold demand for those items never surfaced in
        // `scaffold:needs`. Null is also the honest value: an unattached anchor
        // genuinely has no concept.
        conceptId: persistableConceptId(gap.anchorConceptId),
      },
    });
  } catch (err) {
    logger.error('recordScaffoldGap: failed to record gap', {
      rotation: gap.rotation,
      topics: gap.topics,
      anchorItemId: gap.anchorItemId,
      error: String(err),
    });
  }
}
