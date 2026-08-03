/**
 * Knowledge System Types
 *
 * Core types for:
 * - Content lake and fact extraction system
 * - Unified knowledge state (exposure tracking, mastery computation)
 *
 * See docs/designs/2026-01-13-unified-knowledge-state.md
 */

// =============================================================================
// EXPOSURE TRACKING TYPES
// =============================================================================

export type ExposureType =
  | 'page_read' // Scrolled through content (weak)
  | 'content_expanded' // Clicked LearnMore/DeepDive (medium)
  | 'video_watched' // Watched embedded video (weak-medium)
  | 'card_reviewed' // Cloze card with quality rating (strong)
  | 'mcq_attempted' // MCQ with correct/incorrect (strongest)
  | 'mcq_self_assessed' // MCQ skipped then self-rated (like card_reviewed)
  | 'table_quiz' // Table cell quiz (medium-strong)
  | 'image_occlusion' // Image label quiz (medium-strong)
  | 'skill_drill'; // ALS/ECG practice (strong for skills)

export interface ExposureInput {
  userId: string;
  exposureType: ExposureType;
  sourceType?: 'card' | 'question' | 'page' | 'table' | 'image' | 'skill' | 'video';
  sourceId?: string;
  conceptIds?: string[]; // Explicit concept mapping (optional, can be inferred)
  metadata?: ExposureMetadata;
}

export interface ExposureMetadata {
  // For page_read
  scrollDepth?: number; // 0-1
  durationSeconds?: number;

  // For card_reviewed
  quality?: number; // 0-5
  responseTimeMs?: number;

  // For mcq_attempted
  isCorrect?: boolean;

  // For table_quiz / image_occlusion
  accuracy?: number; // 0-1

  // For content_expanded
  expandedDurationSeconds?: number;

  // Generic
  [key: string]: unknown;
}

/**
 * Strength weights for different exposure types
 * These are tunable parameters
 */
export const EXPOSURE_WEIGHTS = {
  page_read: {
    base: 0.1,
    scrollMultiplier: 1.0, // × scrollDepth
    durationCap: 300, // seconds, for normalization
  },
  content_expanded: {
    base: 0.2,
    durationCap: 30, // seconds
  },
  video_watched: {
    base: 0.15,
  },
  card_reviewed: {
    // Varies by quality: 0→0.1, 3→0.4, 5→0.6
    quality0: 0.1,
    quality3: 0.4,
    quality5: 0.6,
  },
  mcq_attempted: {
    wrong: 0.3,
    correct: 0.7,
  },
  mcq_self_assessed: {
    // Self-assessed MCQs treated like card reviews
    quality0: 0.1,
    quality3: 0.4,
    quality5: 0.6,
  },
  table_quiz: {
    base: 0.4,
  },
  image_occlusion: {
    base: 0.4,
  },
  skill_drill: {
    base: 0.5,
  },
} as const;

/**
 * Decay model parameters (tunable)
 */
export const DECAY_PARAMS = {
  baseHalfLifeDays: 7, // Base half-life in days
  confidenceMultiplier: 2, // How much confidence extends half-life (1 + conf * multiplier)
} as const;

// =============================================================================
// FACT EXTRACTION TYPES (existing)
// =============================================================================

export interface ExtractedFact {
  statement: string;
  topics: string[];
  concepts: string[];
  confidence: number; // 0-1, how clearly the source states this
}

export interface IngestRequest {
  content: string;
  source: string; // "CC Bible p.42", "Week 1 lecture", etc.
  rotation: string;
  week: number;
}

export interface IngestResult {
  factsCreated: number;
  factsUpdated: number; // Deduplicated into existing facts
  factIds: string[];
}

export interface FactWithRelations {
  id: string;
  statement: string;
  citations: string[];
  verified: boolean;
  flagged: boolean;
  rotation: string;
  week: number;
  topics: string[];
  examWeight: number;
  prerequisiteIds: string[];
  concepts: Array<{
    concept: {
      id: string;
      name: string;
    };
    isPrimary: boolean;
  }>;
  cards: Array<{
    id: string;
    front: string;
  }>;
}

export interface CoverageReport {
  rotation: string;
  week: number;
  factCount: number;
  verifiedCount: number;
  flaggedCount: number;
  cardCount: number;
  topics: Array<{
    topic: string;
    count: number;
  }>;
}
