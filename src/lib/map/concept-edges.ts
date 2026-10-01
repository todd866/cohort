/**
 * Edges for the concept Map graph. Two kinds, both grounded in data md3 already
 * has (no new infrastructure):
 *   - similarity : concept-embedding kNN cosine (available on every rotation —
 *                  100% concept-embedding coverage). Undirected.
 *   - prereq     : the authored prerequisite DAG (Concept.prerequisiteIds; live
 *                  on critical-care today). Directed prereq -> concept, and it
 *                  supersedes a similarity edge on the same pair.
 *
 * Pure function — the caller loads the ≤N concept embeddings via
 * batchLoadConceptEmbeddings (allowlisted by the embedding-egress rule: concept
 * vectors are ~100 rows and may live in Node).
 * See docs/superpowers/specs/2026-07-22-mobile-review-desktop-concept-map.md §4.3.
 */

import { cosineSimilarity } from '@/lib/math/vector-math';

export type ConceptEdgeKind = 'similarity' | 'prereq';

export interface ConceptEdge {
  source: string;
  target: string;
  kind: ConceptEdgeKind;
  /** cosine similarity for 'similarity', 1 for 'prereq'. */
  weight: number;
}

export interface ConceptForEdges {
  id: string;
  embedding: number[] | null;
  prerequisiteIds: string[];
}

export interface ConceptEdgeOptions {
  /** Max similarity neighbours kept per concept. Default 6. */
  k?: number;
  /** Minimum cosine to keep a similarity edge. Default 0.4. */
  minSimilarity?: number;
}

/** Stable unordered key for de-duping an undirected pair. */
export function edgeKey(e: { source: string; target: string }): string {
  return [e.source, e.target].sort().join('|');
}

export function buildConceptEdges(
  concepts: ConceptForEdges[],
  options: ConceptEdgeOptions = {},
): ConceptEdge[] {
  const k = options.k ?? 6;
  const minSimilarity = options.minSimilarity ?? 0.4;
  const idSet = new Set(concepts.map((c) => c.id));

  // Prerequisite edges (directed). Track their unordered pairs so similarity
  // doesn't duplicate a link the DAG already expresses.
  const prereqEdges: ConceptEdge[] = [];
  const prereqPairs = new Set<string>();
  for (const c of concepts) {
    for (const pid of c.prerequisiteIds) {
      if (pid !== c.id && idSet.has(pid)) {
        prereqEdges.push({ source: pid, target: c.id, kind: 'prereq', weight: 1 });
        prereqPairs.add(edgeKey({ source: pid, target: c.id }));
      }
    }
  }

  // Similarity kNN (undirected, de-duped, thresholded).
  const withEmbedding = concepts.filter((c) => c.embedding && c.embedding.length > 0);
  const simByKey = new Map<string, ConceptEdge>();
  for (const a of withEmbedding) {
    const nearest = withEmbedding
      .filter((b) => b.id !== a.id)
      .map((b) => ({ id: b.id, sim: cosineSimilarity(a.embedding as number[], b.embedding as number[]) }))
      .filter((s) => s.sim >= minSimilarity)
      .sort((x, y) => y.sim - x.sim)
      .slice(0, k);

    for (const s of nearest) {
      const key = edgeKey({ source: a.id, target: s.id });
      if (prereqPairs.has(key)) continue; // the DAG edge wins
      const existing = simByKey.get(key);
      if (!existing || s.sim > existing.weight) {
        const [source, target] = [a.id, s.id].sort();
        simByKey.set(key, { source, target, kind: 'similarity', weight: s.sim });
      }
    }
  }

  return [...prereqEdges, ...simByKey.values()];
}
