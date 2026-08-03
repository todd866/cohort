/**
 * Unified Learning State Module
 *
 * This module provides a single write path for all learning interactions.
 * See docs/designs/2026-01-17-unified-learning-state.md
 */

export {
  recordLearningEvent,
  prepareLearningEvent,
  createPreparedLearningEvent,
  applyLearningEventDerivedState,
  getConceptIdsForCard,
  getConceptIdsForQuestion,
  getConceptIdsForPage,
  type LearningEventInput,
  type LearningEventType,
  type RecordEventResult,
  type PreparedLearningEvent,
} from './record-event';

// Content Exposure Tracking (Phase 1 of Learning Analytics)
export {
  logContentExposure,
  markExposureEngaged,
  logMultipleExposures,
  getRecentExposures,
  getExposureStats,
  type ContentExposureInput,
  type PrimaryContentType,
  type ExposureType,
  type ExposureReason,
} from './content-exposure';
