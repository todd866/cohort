import { CLUSTER_NAMES, type ClusterNameEntry } from './cluster-names.data';

/**
 * Authored names for manifold regions, preferred over the auto-label.
 *
 * `Cluster.name` is generated from the commonest topic tag of a region's
 * members, which is exactly the tag that CANNOT distinguish it from its
 * siblings — so seven CAH regions were all labelled "Surgery" and seven more
 * "Neurology", while one holding night terrors and slow-wave sleep was labelled
 * "Respiratory". `cluster-names.data.ts` carries names read off what is
 * actually in each region, with the evidence that justified each one.
 *
 * Display only. Cluster ids remain the identity and nothing keys off these
 * strings, so a wrong name costs a commit rather than a migration.
 */

const OVERLAY: Readonly<Record<string, ClusterNameEntry>> = CLUSTER_NAMES;

/**
 * The authored name for a cluster, or null to keep the generated label.
 *
 * Returns null for an unnamed-but-flagged region on purpose. Inventing a label
 * for a region we have explicitly declined to name would hide the finding, and
 * the generated label at least stays recognisably poor. `_meta` is documentation
 * rather than a cluster and is ignored.
 */
export function authoredClusterName(clusterId: string): string | null {
  if (clusterId === '_meta') return null;
  const entry = OVERLAY[clusterId];
  if (!entry || typeof entry.name !== 'string') return null;
  const trimmed = entry.name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Whether this region has been judged un-nameable and awaits a split. */
export function clusterNeedsSplit(clusterId: string): boolean {
  return clusterId !== '_meta' && OVERLAY[clusterId]?.needsSplit === true;
}

/** Why a region carries the name (or the refusal) it does. */
export function clusterNameEvidence(clusterId: string): string | null {
  if (clusterId === '_meta') return null;
  return OVERLAY[clusterId]?.evidence ?? null;
}
