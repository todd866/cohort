import type { QuestionGroupStep } from '@/lib/question-groups/types';

export interface ReviewItem {
  type: 'card' | 'question' | 'group' | 'video';
  id: string;
  // Card fields
  front?: string;
  back?: string;
  backs?: string[] | null;
  context?: string | null;
  sourceComponent?: string;
  crosslinks?: {
    primary?: string;
    related?: string[];
    concepts?: string[];
  } | null;
  // Question fields
  stem?: string;
  options?: Array<{
    label: string;
    text: string;
    isCorrect: boolean;
    originalIndex?: number;
    explanation?: string;
  }>;
  // Group fields (linked question groups - ECG, ABG, etc.)
  groupType?: string;
  contextImageUrl?: string | null;
  contextText?: string | null;
  steps?: QuestionGroupStep[];
  diagnosisSummary?: string | null;
  difficulty?: string;
  topics?: string[];
  // Video fields
  videoTitle?: string;
  videoUrl?: string;
  videoThumbnailUrl?: string | null;
  videoDuration?: number;
  creatorName?: string;
  conceptName?: string;
  // Image (cards and questions)
  imageUrl?: string | null;
  imageCaption?: string | null;
  /** Stable canonical key (e.g. `/figures/cah/derm/foo.jpg`) from resolveImage.
   *  Used as the analytics identity in useImageTracking — `imageUrl` above is
   *  a short-lived signed R2 URL and would leak its X-Amz-Signature into
   *  FeedEvent rows. */
  imageKey?: string | null;
  /** Sidecar-derived metadata: class, showWhen, key findings. Lets the
   *  renderer hide pre-reveal for non-diagnostic images. */
  imageMeta?: import('@/lib/figures/types').ClientImageMeta;
  // Shared
  rotation: string;
  week?: number | null;
  complexity?: number;
  /** Teaching signal ID for prediction/outcome tracking */
  signalId?: string;
  /** Which blend tier served this item (for engagement analytics) */
  blendTier?: 'primary' | 'rereview' | 'cross-rotation';
  /** Decision context for scheduler observability — echoed back on submit */
  decisionContext?: Record<string, unknown>;
  /** Walk-audit traceability: echoed back to POST /api/study/record */
  sessionId?: string | null;
  batchId?: string | null;
  /** Per-item serve-decision trace ID; echoed back to POST /api/study/record */
  serveDecisionId?: string;
}

export interface ReviewStats {
  total: number;
  correct: number;
}
