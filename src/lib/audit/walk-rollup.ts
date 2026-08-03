import type { RollupMetrics, SessionMetrics, Pathology, Session } from './walk-types';

const EMPTY_PATHOLOGY_COUNTS: RollupMetrics['pathologyCounts'] = {
  'stuck-in-cluster': 0,
  'thrashing': 0,
  'over-tight': 0,
  'no-scaffolding-on-fail': 0,
  'calibration-too-easy': 0,
  'calibration-too-hard': 0,
  'modality-monotony': 0,
  'dropout': 0,
  'variant-sibling-repeat': 0,
};

export interface RollupEntry {
  session: Session;
  metrics: SessionMetrics;
  pathologies: Pathology[];
}

export function computeRollup(entries: RollupEntry[]): RollupMetrics {
  let itemCount = 0;
  const similarities: number[] = [];
  const clusterCounts = new Map<string, number>();
  const pathologyCounts: RollupMetrics['pathologyCounts'] = { ...EMPTY_PATHOLOGY_COUNTS };
  const feedModeCounts: RollupMetrics['feedModeCounts'] = { 'mixed': 0, 'new-only': 0 };

  for (const entry of entries) {
    itemCount += entry.session.trajectory.length;
    feedModeCounts[entry.session.feedMode] += 1;
    for (const ev of entry.session.trajectory) {
      if (typeof ev.metadata.similarityToPrior === 'number') {
        similarities.push(ev.metadata.similarityToPrior);
      }
      const cid = ev.metadata.clusterId ?? null;
      if (cid) clusterCounts.set(cid, (clusterCounts.get(cid) ?? 0) + 1);
    }
    for (const p of entry.pathologies) {
      pathologyCounts[p.kind] = (pathologyCounts[p.kind] ?? 0) + 1;
    }
  }

  const avgCoherence = similarities.length === 0
    ? null
    : similarities.reduce((a, b) => a + b, 0) / similarities.length;

  const total = Array.from(clusterCounts.values()).reduce((a, b) => a + b, 0);
  const topServedClusters = Array.from(clusterCounts.entries())
    .map(([clusterId, count]) => ({ clusterId, count, pct: total === 0 ? 0 : count / total }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    sessionCount: entries.length,
    itemCount,
    avgCoherence,
    clusterCoverage: clusterCounts.size,
    topServedClusters,
    pathologyCounts,
    feedModeCounts,
  };
}
