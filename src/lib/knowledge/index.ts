/**
 * Knowledge System
 *
 * - Content lake for ingesting, extracting, and managing medical facts
 * - Unified knowledge state (exposure tracking, mastery computation)
 *
 * See docs/designs/2026-01-13-unified-knowledge-state.md
 */

// Fact extraction
export { extractFacts, chunkContent } from './extract';
export { ingestContent, getCoverage } from './ingest';

// Exposure tracking
export {
  logExposure,
  computeExposureStrength,
  isProbeType,
  getConceptsForSource,
} from './exposure';

// Knowledge state computation
export {
  applyDecay,
  applyExposure,
  updateConfidence,
  projectRecallToExamDay,
  computeKnowledgeState,
} from './state';

// Types
export type {
  ExtractedFact,
  IngestRequest,
  IngestResult,
  FactWithRelations,
  CoverageReport,
  ExposureType,
  ExposureInput,
  ExposureMetadata,
} from './types';

export { EXPOSURE_WEIGHTS, DECAY_PARAMS } from './types';
