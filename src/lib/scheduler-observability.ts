export interface DecisionContext {
  // Existing fields
  servedBy?: 'manifold-walk' | 'feed-score' | 'starter' | 'cached' | 'weekly-review' | 'content-page' | 'instant' | 'rereview' | 'focused';
  sessionType?: 'review' | 'feed' | 'content-page' | 'weekly-review';
  sessionId?: string;
  embeddingType?: 'multimodal-video' | 'text-surrogate' | 'concept-embedding' | 'metadata-only' | 'none';
  similarityToTarget?: number;
  rankInPool?: number;
  poolSize?: number;
  predictedRecall?: number;
  retrievalStrengthBefore?: number;
  controllerState?: {
    memeRatio: number;
    temperature: number;
    exploration: number;
    noveltyBias: number;
  };
  toneAtServe?: 'meme' | 'educational';

  // New: walk decision context (Phase 1 of 2026-04-17-scheduler-walk-audit)
  batchId?: string;
  positionInSession?: number;
  clusterId?: string | null;
  similarityToPrior?: number | null;
  difficultyTier?: 'scaffolding' | 'standard' | 'stretch' | null;
}

export function mergeDecisionContext(
  internal: Record<string, unknown> | undefined,
  decision: DecisionContext | undefined
): Record<string, unknown> | undefined {
  if (!internal && !decision) return undefined;
  return { ...internal, ...decision };
}
