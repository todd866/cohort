/**
 * Text similarity utilities for question deduplication.
 *
 * Uses character trigrams + Jaccard similarity for fuzzy stem matching,
 * and set overlap for topic comparison.
 */

/**
 * Generate character trigrams from a string.
 * Normalizes to lowercase and strips punctuation.
 */
export function trigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  if (normalized.length < 3) return new Set();

  const result = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    result.add(normalized.slice(i, i + 3));
  }
  return result;
}

/**
 * Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|
 */
export function jaccardSimilarity<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute trigram-based Jaccard similarity between two question stems.
 */
export function stemSimilarity(stemA: string, stemB: string): number {
  const triA = trigrams(stemA);
  const triB = trigrams(stemB);
  return jaccardSimilarity(triA, triB);
}

/**
 * Topic overlap: |intersection| / min(|A|, |B|)
 * Uses min-denominator so a subset scores 1.0.
 */
export function topicOverlap(topicsA: string[], topicsB: string[]): number {
  if (topicsA.length === 0 || topicsB.length === 0) return 0;

  const setA = new Set(topicsA.map((t) => t.toLowerCase()));
  const setB = new Set(topicsB.map((t) => t.toLowerCase()));

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const minSize = Math.min(setA.size, setB.size);
  return minSize === 0 ? 0 : intersection / minSize;
}
