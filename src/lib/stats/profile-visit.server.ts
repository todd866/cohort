/** The existing progress histogram is sufficient for the optional recall estimate. */
import { toProfileVisit, type ProfileVisitModel } from './profile-visit';
import { loadProgressRows, type StatsDb } from './stats-query.server';
import { buildRetrievabilityHistogram, sydneyDay } from './stats-model';

export async function loadProfileVisit(db: StatsDb, userId: string, now: Date): Promise<ProfileVisitModel> {
  const progressRows = await loadProgressRows(db, userId, {
    today: sydneyDay(now), rotation: null,
  });
  return toProfileVisit({ retrievability: buildRetrievabilityHistogram(progressRows), trend: null });
}
