/**
 * Knowledge Manifold
 *
 * Vector-based knowledge organization for exam-focused spaced repetition.
 * Designed for scale: 250k+ cards, HNSW indexing, batch operations.
 */

export { embedContent, embedBatch, formatCardForEmbedding, type EmbeddingResult } from './embeddings';
export {
  findSimilar,
  findCrossRotation,
  findCardsForQuestion,
  findQuestionsForCard,
  findCardsNearVector,
  findQuestionsNearVector,
  findVideosNearVector,
  batchLoadConceptEmbeddings,
  batchLoadItemEmbeddings,
  loadQuestionEmbedding,
  type SimilarCard,
  type SimilarQuestion,
} from './similarity';
export {
  inferMastery,
  findKnowledgeGaps,
  getManifoldCoverage,
  updateRetrievalStrength,
  updateStabilityDays,
  computeNextDueAt,
  getCrossRotationTransfer,
  getGlobalKnowledgeState,
  // Decay functions for exam-day scheduling
  calculateDecayedStrength,
  getCurrentRetrievalStrength,
  predictRetrievalStrengthOnDate,
  type MasteryEstimate,
} from './inference';
export {
  participationRatio,
  spectralDimensionality,
  computeHubness,
  findNeighborEmbeddings,
  distractorGapDirection,
  type DimensionalityResult,
  type HubnessResult,
} from './dimensionality';
export {
  computeFlowAxis,
  getFlowDepth,
  getFlowAxis,
  scoreFlowAxis,
  type FlowAxisResult,
  type FlowAxisQuality,
} from './flow-axis';
