import { cosineSimilarity } from '@/lib/math/vector-math';
import { FEED_DEFAULT_MEME_RATIO, MEME_SERIOUSNESS_THRESHOLD } from '@/lib/constants';
import { clamp } from '@/lib/utils/clamp';

const DEFAULT_TEMPERATURE = 0.45;
const DEFAULT_EXPLORATION = 0.2;
const DEFAULT_NOVELTY_BIAS = 0.35;

export interface VideoFeedController {
  memeRatio: number;
  toneBias: number;
  temperature: number;
  exploration: number;
  noveltyBias: number;
  maxConsecutiveMemes: number;
}

export interface WeakConceptSignal {
  conceptId: string;
  priority: number;
}

export interface VideoManifoldCandidate {
  id: string;
  tone?: string | null;
  seriousness?: number | null;
  qualityScore: number;
  conceptScore: number;
  rotationScore: number;
  weekScore?: number;
}

export interface BuildVideoManifoldFeedOptions {
  embeddings: Map<string, number[]>;
  targetVector?: number[] | null;
  controller: VideoFeedController;
  limit: number;
  seed: number;
}

export function parseVideoFeedController(feedBias: unknown): VideoFeedController {
  const bias =
    feedBias && typeof feedBias === 'object'
      ? (feedBias as Record<string, unknown>)
      : {};

  const memeRatio = clampNumber(bias.memeRatio, 0, 1, FEED_DEFAULT_MEME_RATIO);
  const temperature = clampNumber(bias.temperature, 0.05, 1.5, DEFAULT_TEMPERATURE);
  const exploration = clampNumber(bias.exploration, 0, 1, DEFAULT_EXPLORATION);
  const noveltyBias = clampNumber(bias.noveltyBias, 0, 1, DEFAULT_NOVELTY_BIAS);

  return {
    memeRatio,
    toneBias: memeRatio * 2 - 1,
    temperature,
    exploration,
    noveltyBias,
    maxConsecutiveMemes: memeRatio >= 0.65 ? 2 : 1,
  };
}

export function buildWeakConceptTarget(
  weakConcepts: WeakConceptSignal[],
  conceptEmbeddings: Map<string, number[]>
): number[] | null {
  let totalWeight = 0;
  let accumulator: number[] | null = null;

  for (const concept of weakConcepts) {
    const embedding = conceptEmbeddings.get(concept.conceptId);
    if (!embedding || embedding.length === 0 || concept.priority <= 0) continue;

    if (!accumulator) {
      accumulator = new Array(embedding.length).fill(0);
    }

    for (let i = 0; i < embedding.length; i++) {
      accumulator[i] += embedding[i] * concept.priority;
    }
    totalWeight += concept.priority;
  }

  if (!accumulator || totalWeight === 0) return null;
  return normalizeVector(accumulator.map((value) => value / totalWeight));
}

export function normalizeEditorialScore(rawScore: number): number {
  return clamp((rawScore + 5) / 15, 0, 1);
}

export function buildVideoManifoldFeed<T extends VideoManifoldCandidate>(
  candidates: T[],
  options: BuildVideoManifoldFeedOptions
): T[] {
  if (candidates.length === 0) return [];

  const { embeddings, targetVector, controller, seed } = options;
  const limit = Math.max(0, Math.min(options.limit, candidates.length));
  if (limit === 0) return [];

  const rng = mulberry32(seed >>> 0);
  const remaining = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ordered: T[] = [];
  let centroid: number[] | null = null;
  let memeCount = 0;

  while (ordered.length < limit && remaining.size > 0) {
    const scored = [...remaining.values()]
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, {
          embeddings,
          targetVector,
          controller,
          currentId: ordered.length > 0 ? ordered[ordered.length - 1].id : null,
          centroid,
          selectedCount: ordered.length,
          memeCount,
          memeStreak: countRecentMemeStreak(ordered),
        }),
      }))
      .sort((a, b) => b.score - a.score);

    const next =
      controller.temperature <= 0.08 && controller.exploration <= 0.01
        ? scored[0]?.candidate
        : sampleCandidate(scored, controller, rng);

    if (!next) break;

    ordered.push(next);
    remaining.delete(next.id);

    if (isMeme(next)) {
      memeCount += 1;
    }

    const embedding = embeddings.get(next.id);
    if (embedding) {
      centroid = updateCentroid(centroid, embedding, ordered.length);
    }
  }

  return ordered;
}

function scoreCandidate(
  candidate: VideoManifoldCandidate,
  context: {
    embeddings: Map<string, number[]>;
    targetVector?: number[] | null;
    controller: VideoFeedController;
    currentId: string | null;
    centroid: number[] | null;
    selectedCount: number;
    memeCount: number;
    memeStreak: number;
  }
): number {
  const {
    embeddings,
    targetVector,
    controller,
    currentId,
    centroid,
    selectedCount,
    memeCount,
    memeStreak,
  } = context;

  const candidateEmbedding = embeddings.get(candidate.id);
  const currentEmbedding = currentId ? embeddings.get(currentId) : null;

  const targetSimilarity =
    candidateEmbedding && targetVector
      ? Math.max(0, safeCosineSimilarity(candidateEmbedding, targetVector))
      : 0;

  const transitionSimilarity =
    candidateEmbedding && currentEmbedding
      ? safeCosineSimilarity(candidateEmbedding, currentEmbedding)
      : 0;

  const transitionScore = currentId ? scoreTransition(transitionSimilarity) : 0;

  const noveltyScore =
    candidateEmbedding && centroid
      ? (1 - Math.max(0, safeCosineSimilarity(candidateEmbedding, centroid))) *
        (0.15 + controller.noveltyBias * 0.45)
      : 0;

  const toneBaseScore =
    (isMeme(candidate) ? controller.toneBias : -controller.toneBias) * 0.45;

  const toneRatioScore = scoreToneRatio(candidate, selectedCount, memeCount, controller);

  const streakPenalty =
    isMeme(candidate) && memeStreak >= controller.maxConsecutiveMemes ? -2 : 0;

  return (
    candidate.qualityScore * 0.55 +
    candidate.conceptScore * 1.2 +
    candidate.rotationScore * 0.3 +
    (candidate.weekScore ?? 0) * 0.9 +
    targetSimilarity * 1.1 +
    transitionScore +
    noveltyScore +
    toneBaseScore +
    toneRatioScore +
    streakPenalty
  );
}

function scoreTransition(similarity: number): number {
  if (similarity >= 0.45 && similarity <= 0.9) {
    const midpoint = 0.68;
    return 0.45 - Math.abs(similarity - midpoint) * 0.35;
  }

  if (similarity > 0.9) {
    return 0.32 - (similarity - 0.9) * 0.8;
  }

  return similarity * 0.25;
}

function scoreToneRatio(
  candidate: VideoManifoldCandidate,
  selectedCount: number,
  memeCount: number,
  controller: VideoFeedController
): number {
  if (selectedCount === 0) {
    const isCandidateMeme = isMeme(candidate) ? 1 : 0;
    return (0.5 - Math.abs(isCandidateMeme - controller.memeRatio)) * 0.6;
  }

  const currentRatio = memeCount / selectedCount;
  const nextRatio =
    (memeCount + (isMeme(candidate) ? 1 : 0)) / (selectedCount + 1);

  return (Math.abs(currentRatio - controller.memeRatio) - Math.abs(nextRatio - controller.memeRatio)) * 0.8;
}

function sampleCandidate<T extends VideoManifoldCandidate>(
  scored: Array<{ candidate: T; score: number }>,
  controller: VideoFeedController,
  random: () => number
): T | null {
  if (scored.length === 0) return null;

  const topK = Math.min(
    scored.length,
    Math.max(3, Math.round(3 + controller.exploration * 5))
  );
  const pool = scored.slice(0, topK);
  const maxScore = pool[0]?.score ?? 0;
  const temperature = Math.max(0.05, controller.temperature);

  const weights = pool.map((entry) => {
    const softmax = Math.exp((entry.score - maxScore) / temperature);
    const uniform = 1 / pool.length;
    return softmax * (1 - controller.exploration) + uniform * controller.exploration;
  });

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return pool[0]?.candidate ?? null;

  let roll = random() * totalWeight;
  for (let index = 0; index < pool.length; index++) {
    roll -= weights[index];
    if (roll <= 0) return pool[index].candidate;
  }

  return pool[pool.length - 1]?.candidate ?? null;
}

function updateCentroid(
  centroid: number[] | null,
  embedding: number[],
  count: number
): number[] {
  if (!centroid) return [...embedding];

  const next = [...centroid];
  for (let i = 0; i < Math.min(next.length, embedding.length); i++) {
    next[i] = next[i] * ((count - 1) / count) + embedding[i] / count;
  }
  return next;
}

function normalizeVector(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return values;
  return values.map((value) => value / norm);
}

function safeCosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  return cosineSimilarity(a, b);
}

function countRecentMemeStreak(items: VideoManifoldCandidate[]): number {
  let streak = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    if (!isMeme(items[index])) break;
    streak += 1;
  }
  return streak;
}

function isMeme(candidate: Pick<VideoManifoldCandidate, 'tone' | 'seriousness'>): boolean {
  if (candidate.seriousness != null) return candidate.seriousness < MEME_SERIOUSNESS_THRESHOLD;
  return candidate.tone === 'meme';
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return clamp(value, min, max);
}
