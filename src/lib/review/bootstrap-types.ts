import type { Institution } from '@/lib/institution';
import type { TrackNumber } from '@/lib/rotation-context';
import type { ReviewFeedMode } from './feed-mode';
import type { InitialReviewBatch } from '@/components/review/hooks/useReviewSession';

export interface ReviewUserContext {
  ownerKey: string;
  institution: Institution;
  track: TrackNumber | null;
  activeModules: string[];
  activeRotations: string[];
  /** Server-authorized private topic-to-rotation bindings for this viewer. */
  reviewTopicRotations?: Readonly<Record<string, string>>;
  /**
   * For a cluster named in the URL: which rotations it has LIVE cards in.
   * `{}` means "not looked up" and the resolver keeps its format-only check;
   * `{ [id]: [] }` means the server looked and found none, so the client's own
   * parse rejects it too and renders "unavailable" instead of an unscoped
   * session. Clusters are cross-rotation by design (17 of 872 span more than
   * one), so a rotation+cluster pair can contradict itself.
   */
  reviewClusterRotations?: Readonly<Record<string, readonly string[]>>;
  /**
   * Display identity of the cluster this session is scoped to, resolved beside
   * the liveness check that already had to run. Null when unscoped. The review
   * surface has no other route to it — the URL carries only an opaque id — and
   * without it a scoped session is indistinguishable from an ordinary one.
   */
  reviewClusterScope?: {
    id: string;
    label: string;
    cardCount: number;
    rotation: string | null;
  } | null;
}

export interface ReviewServerBootstrap {
  /** Exact public review-intent query represented by this payload. */
  locationKey: string;
  institution: Institution;
  track: TrackNumber | null;
  activeRotations: string[];
  activeModules: string[];
  /** Server-authorized private topic-to-rotation bindings for this viewer. */
  reviewTopicRotations?: Readonly<Record<string, string>>;
  /**
   * For a cluster named in the URL: which rotations it has LIVE cards in.
   * `{}` means "not looked up" and the resolver keeps its format-only check;
   * `{ [id]: [] }` means the server looked and found none, so the client's own
   * parse rejects it too and renders "unavailable" instead of an unscoped
   * session. Clusters are cross-rotation by design (17 of 872 span more than
   * one), so a rotation+cluster pair can contradict itself.
   */
  reviewClusterRotations?: Readonly<Record<string, readonly string[]>>;
  /**
   * Display identity of the cluster this session is scoped to, resolved beside
   * the liveness check that already had to run. Null when unscoped. The review
   * surface has no other route to it — the URL carries only an opaque id — and
   * without it a scoped session is indistinguishable from an ordinary one.
   */
  reviewClusterScope?: {
    id: string;
    label: string;
    cardCount: number;
    rotation: string | null;
  } | null;
  reviewed: number;
  feedMode: ReviewFeedMode;
  initialBatch: InitialReviewBatch;
}
