/**
 * How often this user has actually been shown each figure.
 *
 * Delivered serves only. A cache-build decision records what was queued, not
 * what the student saw, so counting it would space out a figure the user never
 * actually looked at.
 *
 * BACKGROUND USE ONLY — do not call this from a request path. The obvious
 * single-statement form (ServeDecision JOIN Card, GROUP BY imageUrl) measured
 * ~3s: the planner ignores the composite index in favour of the plain decidedAt
 * one and hash-joins the whole 95k-row Card table. Splitting it — group the
 * indexed side first, then look up only the few thousand cards that appear —
 * brings it to ~550ms, which is still far too much to add to a session request
 * that users already see time out. It runs in the background cache refresh,
 * which builds most of what is actually delivered.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { FIGURE_MAX_COOLDOWN_HOURS, type FigureExposure } from './figure-cooldown';

/** Look back exactly as far as the longest interval can reach; older showings
 *  can no longer suppress anything, so fetching them is wasted work. */
export const FIGURE_EXPOSURE_WINDOW_MS = FIGURE_MAX_COOLDOWN_HOURS * 60 * 60 * 1000;

export async function fetchRecentFigureExposures(
  userId: string,
  nowMs: number = Date.now(),
): Promise<Map<string, FigureExposure>> {
  const since = new Date(nowMs - FIGURE_EXPOSURE_WINDOW_MS);
  try {
    const grouped = await prisma.serveDecision.groupBy({
      by: ['itemId'],
      where: {
        userId,
        itemType: 'card',
        deliveryPath: { in: ['live', 'cached'] },
        decidedAt: { gte: since },
      },
      _count: { itemId: true },
      _max: { decidedAt: true },
    });
    if (grouped.length === 0) return new Map();

    const cards = await prisma.card.findMany({
      where: { id: { in: grouped.map((g) => g.itemId) }, imageUrl: { not: null } },
      select: { id: true, imageUrl: true },
    });
    const figureOf = new Map(cards.map((c) => [c.id, c.imageUrl!]));

    // Several cards can share a figure, so fold their showings together.
    const out = new Map<string, FigureExposure>();
    for (const g of grouped) {
      const url = figureOf.get(g.itemId);
      if (!url) continue;
      const seenAt = g._max.decidedAt?.getTime() ?? 0;
      const prev = out.get(url);
      if (prev) {
        prev.count += g._count.itemId;
        prev.mostRecentMs = Math.max(prev.mostRecentMs, seenAt);
      } else {
        out.set(url, { count: g._count.itemId, mostRecentMs: seenAt });
      }
    }
    return out;
  } catch (error) {
    // Losing this costs figure spacing for one session, never the session.
    logger.warn('Failed to load figure exposures; serving without figure spacing', {
      userId,
      error: String(error),
    });
    return new Map();
  }
}
