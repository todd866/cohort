import { prisma } from '@/lib/prisma';
import { EstimatedKnowledge } from '@/components/stats/EstimatedKnowledge';
import { loadProfileVisit } from '@/lib/stats/profile-visit.server';
import type { StatsDb } from '@/lib/stats/stats-query.server';

/** Optional recall estimate, streamed inside the profile's closed insights row. */
export async function ProfileVisitSection({ userId }: { userId: string }) {
  let visit;
  try {
    visit = await loadProfileVisit(prisma as unknown as StatsDb, userId, new Date());
  } catch {
    // The data read can fail independently of the rest of Profile.
  }
  return visit ? <EstimatedKnowledge cards={visit.knowledge} trend={visit.trend} />
    : <p className="py-2 text-sm text-[var(--md-on-surface-variant)]">Couldn&apos;t load</p>;
}
