/**
 * Assembles the full desktop concept-Map graph for a user + rotation:
 * honest terrain nodes (performance + established-ness) + edges (embedding kNN +
 * prereq DAG). Scalar-only payload — the 3072-D concept vectors are loaded into
 * Node to compute edge weights and then discarded; they never reach the client.
 *
 * See docs/superpowers/specs/2026-07-22-mobile-review-desktop-concept-map.md.
 */

import { prisma } from '@/lib/prisma';
import { batchLoadConceptEmbeddings } from '@/lib/manifold/similarity';
import { getConceptTerrain } from './concept-terrain-service';
import { buildConceptEdges, type ConceptEdge, type ConceptEdgeOptions } from './concept-edges';
import type { ConceptTerrainNode, ConceptTerrainOptions } from './concept-terrain';

export interface ConceptGraph {
  rotation: string;
  nodes: ConceptTerrainNode[];
  edges: ConceptEdge[];
}

export async function getConceptGraph(
  userId: string,
  rotation: string,
  options: {
    terrain?: Partial<ConceptTerrainOptions>;
    edges?: ConceptEdgeOptions;
  } = {},
): Promise<ConceptGraph> {
  const nodes = await getConceptTerrain(userId, rotation, options.terrain);
  if (nodes.length === 0) return { rotation, nodes: [], edges: [] };

  const meta = await prisma.concept.findMany({
    where: { rotation },
    select: { id: true, prerequisiteIds: true },
  });
  const embeddings = await batchLoadConceptEmbeddings(meta.map((c) => c.id));

  const edges = buildConceptEdges(
    meta.map((c) => ({
      id: c.id,
      embedding: embeddings.get(c.id) ?? null,
      prerequisiteIds: c.prerequisiteIds,
    })),
    options.edges,
  );

  return { rotation, nodes, edges };
}
