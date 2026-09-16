import type { GeneratedCard } from '@/lib/card-generator';

export interface ClusterAssignmentTarget {
  id: string;
  rotations: string[];
}

export interface ClusterAssignmentIssue {
  clusterId: string;
  rotation: string;
  reason: 'missing-cluster' | 'rotation-mismatch';
}

type ClusterAssignedCard = Pick<GeneratedCard, 'clusterId' | 'rotation'>;

/**
 * Validate explicit authored card-to-cluster assignments without inspecting or
 * reporting card content. Duplicate assignment failures are collapsed so seed
 * output remains concise and privacy-safe.
 */
export function validateExplicitClusterAssignments(
  cards: ClusterAssignedCard[],
  clusters: ClusterAssignmentTarget[],
): ClusterAssignmentIssue[] {
  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const issues = new Map<string, ClusterAssignmentIssue>();

  for (const card of cards) {
    if (!card.clusterId) continue;

    const cluster = clustersById.get(card.clusterId);
    const reason = !cluster
      ? 'missing-cluster'
      : cluster.rotations.includes(card.rotation)
        ? null
        : 'rotation-mismatch';

    if (!reason) continue;

    const issue: ClusterAssignmentIssue = {
      clusterId: card.clusterId,
      rotation: card.rotation,
      reason,
    };
    issues.set(`${issue.clusterId}\u0000${issue.rotation}\u0000${issue.reason}`, issue);
  }

  return [...issues.values()].sort((a, b) =>
    a.clusterId.localeCompare(b.clusterId) || a.rotation.localeCompare(b.rotation),
  );
}
