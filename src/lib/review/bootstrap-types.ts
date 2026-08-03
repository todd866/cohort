import type { Institution } from '@/lib/institution';
import type { TrackNumber } from '@/lib/rotation-context';
import type { ReviewFeedMode } from './feed-mode';
import type { InitialReviewBatch } from '@/components/review/hooks/useReviewSession';

export interface ReviewServerBootstrap {
  /** Exact public review-intent query represented by this payload. */
  locationKey: string;
  institution: Institution;
  track: TrackNumber | null;
  activeRotations: string[];
  activeModules: string[];
  reviewed: number;
  feedMode: ReviewFeedMode;
  initialBatch: InitialReviewBatch;
}
