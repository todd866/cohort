'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import type { ReviewFeedMode } from './hooks/useReviewFeedMode';
import { ReviewModeSelector, type ReviewMode } from './ReviewModeSelector';
import { GroupReview } from './GroupReview';
import {
  useReviewSession,
  type FetchSlot,
  type InitialReviewBatch,
} from './hooks/useReviewSession';
import { useCardReview } from './hooks/useCardReview';
import { useMcqReview } from './hooks/useMcqReview';
import { useReviewKeyboard } from './hooks/useReviewKeyboard';
import { postContentRating } from '@/lib/review/content-rating';
import { useSessionProgress } from './hooks/useSessionProgress';
import { useSessionLifecycle } from './hooks/useSessionLifecycle';
import { usePrefetchImages } from '@/hooks/usePrefetchImage';
import { upcomingImageUrls } from './upcoming-images';
import { useFlagging } from './hooks/useFlagging';
import { SessionExpiredPrompt } from '@/components/content/SessionExpiredPrompt';
import { submitGroupAttempt } from '@/lib/group-attempt-submit';
import type { StepResult } from '@/lib/question-groups/types';
import { useGrading } from '@/hooks/useGrading';
import { offlineUserKey } from '@/lib/offline/pack';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import type { ReviewFilter, ReviewItemType, ReviewTopic } from '@/lib/review/review-intent';
import type { ReviewLoadTimer } from '@/lib/review/review-load-telemetry';
import { GuestReviewLoginNudge } from '@/components/ui/LoginNudge';
import { ImageBlurToggle } from '@/components/media/ImageBlurToggle';
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';
import { useCohortHost } from '@/components/CohortHostContext';
import {
  canonicalCohortDemandTopics,
  type CohortFeedProfile,
} from '@/lib/cohort/feed-profile';
import type { CohortExperience } from '@/lib/cohort/experience-prior';
import type { CohortSearchTopicV1 } from '@/lib/cohort/search-topic-contract';

import { RotationFocusSelector } from './RotationFocusSelector';
import { ReviewScopeBanner, type ReviewClusterScope } from './ReviewScopeBanner';
import { RotationOnboarding } from './RotationOnboarding';
import { FlagOverlay } from './FlagOverlay';
import { CohortPrompt } from './CohortPrompt';
import { CohortSearchOverlay } from './CohortSearchOverlay';
import { ProgressPill } from './ProgressPill';
import { ProgressDrawer } from './ProgressDrawer';
import { SessionEmptyState } from './SessionEmptyState';
import { LoadingSkeleton } from './LoadingSkeleton';
import { CardItemView } from './CardItemView';
import { McqItemView } from './McqItemView';
import { VideoItemView } from './VideoItemView';
import { RevealActionLabel } from './RevealActionLabel';
import { itemUsesSidePane, reviewPaneKind, reviewShellWidthClass } from './review-panes';

/** Known review item types (stable reference to avoid re-creating in render) */
const KNOWN_TYPES = new Set(['card', 'question', 'group', 'video']);

interface UnifiedReviewProps {
  rotations: string[];
  week?: number;
  /** Optional per-rotation batch sizes for blend weighting. */
  rotationSizes?: Record<string, number>;
  /** Flexible fetch slots for blend tiers (overrides rotations + rotationSizes). */
  fetchSlots?: FetchSlot[];
  feedMode?: ReviewFeedMode;
  /** Optional typed deep-link filter for this review block. */
  reviewFilter?: ReviewFilter;
  /** MCQ-only review: narrow every slot in this block to questions. */
  itemType?: ReviewItemType;
  /** Checked-in topic filters that narrow this review block. */
  topics?: readonly ReviewTopic[];
  /** One manifold cluster, from a square on the profile knowledge heatmap. */
  cluster?: string | null;
  /** Display identity of that cluster, so the surface can say what it scoped to. */
  clusterScope?: ReviewClusterScope | null;
  onFeedModeChange?: (next: ReviewFeedMode) => void;
  onReviewModeChange?: (next: ReviewMode) => void;
  /** Enrolled studyable rotations (drives the focus selector + its gating). */
  studyableRotations?: string[];
  /** Full scheduled rotation list — enables the "Change rotation…" enrolment switcher. */
  enrollableRotations?: string[];
  /** The scheduled block whose exam is booked — rendered first in the focus menu. */
  examRotation?: string | null;
  /** Currently focused rotation (null = All / blended feed). */
  focusRotation?: string | null;
  onFocusRotationChange?: (next: string | null) => void;
  /** Set by the offline fallback page — see useReviewSession's option of the same name. */
  allowUnverifiedPack?: boolean;
  /** Authenticated first batch assembled for this exact server render. */
  initialBatch?: InitialReviewBatch | null;
  /** Shared cold-start timer from the page client. */
  loadTimer?: ReviewLoadTimer | null;
  /** Cohort public review is server-decided one answer at a time. */
  cohortSingleTurn?: boolean;
}

type CohortWriteKind = 'experience' | 'hook' | 'demand';

interface PendingCohortWrite {
  kind: CohortWriteKind;
  body: Record<string, unknown>;
  refreshAfterSave: boolean;
}

interface CohortWriteState extends PendingCohortWrite {
  status: 'saving' | 'error';
  message?: string;
}

interface CohortProfileSnapshot {
  profile: CohortFeedProfile;
  deep: boolean;
  publicGradedCount: number;
  demandTopics: Array<{ id: string; label: string }>;
  searchTopics: CohortSearchTopicV1[];
}

function applyCohortPatchLocally(
  current: CohortFeedProfile | null,
  body: Record<string, unknown>,
): CohortFeedProfile {
  const base = current ?? { hookCompletedAt: null, explicit: {} };
  const now = new Date().toISOString();
  const explicit = { ...base.explicit };
  if (typeof body.experience === 'string') {
    explicit.experience = body.experience as CohortExperience;
    explicit.experienceSetAt = now;
  }
  if (body.demand && typeof body.demand === 'object') {
    const demand = body.demand as Record<string, unknown>;
    explicit.demand = {
      topics: canonicalCohortDemandTopics(demand.topics),
      askedAt: now,
      ...(demand.dismissed === true ? { dismissed: true } : {}),
    };
  }
  return {
    hookCompletedAt: body.hookCompleted === true
      ? base.hookCompletedAt ?? now
      : base.hookCompletedAt,
    explicit,
  };
}

/**
 * Cohort's experience prior is part of the serving input, so it must resolve
 * before the review-session hook is mounted. This prevents a returning visitor
 * with a completed hook but no experience from creating a delivery that can
 * never legitimately be shown. It also quarantines an SSR batch created before
 * the missing prior was known: after the choice is durable, the client asks the
 * server for a fresh turn instead of adopting that batch.
 */
function CohortProfileBoundary(props: UnifiedReviewProps) {
  const [snapshot, setSnapshot] = useState<CohortProfileSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [experienceWrite, setExperienceWrite] = useState<{
    experience: CohortExperience;
    status: 'saving' | 'error';
    message?: string;
  } | null>(null);
  const experienceWriteInFlightRef = useRef(false);
  const discardInitialBatchRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    void (async () => {
      try {
        const res = await fetchWithDeadline(
          '/api/cohort/profile',
          { cache: 'no-store', signal: controller.signal },
          CLIENT_FETCH_DEADLINE_MS,
        );
        if (!res.ok) {
          const failed = await res.json().catch(() => ({})) as {
            detail?: string;
            error?: string;
          };
          throw new Error(failed.detail || failed.error || `HTTP ${res.status}`);
        }
        const body = await res.json() as {
          profile?: CohortFeedProfile;
          deep?: boolean;
          publicGradedCount?: number;
          demandTopics?: Array<{ id: string; label: string }>;
          searchTopics?: CohortSearchTopicV1[];
        };
        if (controller.signal.aborted) return;
        if (!body.profile) throw new Error('Profile response was incomplete');
        if (body.profile.hookCompletedAt && !body.profile.explicit.experience) {
          discardInitialBatchRef.current = true;
        }
        setSnapshot({
          profile: body.profile,
          deep: Boolean(body.deep),
          publicGradedCount: Number.isSafeInteger(body.publicGradedCount)
            ? Math.max(0, body.publicGradedCount as number)
            : 0,
          demandTopics: Array.isArray(body.demandTopics) ? body.demandTopics : [],
          searchTopics: Array.isArray(body.searchTopics) ? body.searchTopics : [],
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : 'Could not load your study level');
      }
    })();
    return () => { controller.abort(); };
  }, [loadAttempt]);

  const persistExperience = useCallback(async (experience: CohortExperience) => {
    if (!snapshot || experienceWriteInFlightRef.current) return;
    experienceWriteInFlightRef.current = true;
    setExperienceWrite({ experience, status: 'saving' });
    try {
      const res = await fetchWithDeadline('/api/cohort/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ experience }),
        keepalive: true,
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!res.ok) {
        const failed = await res.json().catch(() => ({})) as {
          detail?: string;
          error?: string;
        };
        throw new Error(failed.detail || failed.error || `HTTP ${res.status}`);
      }
      const next = await res.json().catch(() => null) as {
        profile?: CohortFeedProfile;
        deep?: boolean;
      } | null;
      setSnapshot((current) => current ? {
        profile: next?.profile ?? applyCohortPatchLocally(current.profile, { experience }),
        deep: typeof next?.deep === 'boolean' ? next.deep : current.deep,
        publicGradedCount: current.publicGradedCount,
        demandTopics: current.demandTopics,
        searchTopics: current.searchTopics,
      } : current);
      setExperienceWrite(null);
    } catch (error) {
      setExperienceWrite({
        experience,
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not save your choice',
      });
    } finally {
      experienceWriteInFlightRef.current = false;
    }
  }, [snapshot]);

  if (!snapshot) {
    if (loadError) {
      return (
        <div className="mx-auto max-w-sm px-4 py-10 text-center">
          <p role="alert" className="text-[var(--md-error)]">
            Couldn&apos;t load your study level: {loadError}
          </p>
          <button
            type="button"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            className="mt-4 font-medium text-[var(--md-primary)] underline"
          >
            Retry
          </button>
        </div>
      );
    }
    return <LoadingSkeleton />;
  }

  if (snapshot.profile.hookCompletedAt && !snapshot.profile.explicit.experience) {
    return (
      <div className="min-h-[50vh]">
        {experienceWrite?.status === 'saving' && (
          <div role="status" className="fixed left-1/2 top-3 z-[70] -translate-x-1/2 rounded-full bg-[var(--md-on-surface)] px-4 py-2 text-sm text-[var(--md-surface)] shadow-lg">
            Saving your choice…
          </div>
        )}
        {experienceWrite?.status === 'error' && (
          <div role="alert" className="fixed left-1/2 top-3 z-[70] flex w-[min(92vw,24rem)] -translate-x-1/2 items-center justify-between gap-3 rounded-lg bg-[var(--md-error-container)] px-4 py-3 text-sm text-[var(--md-on-error-container)] shadow-lg">
            <span>Your choice is still pending: {experienceWrite.message}</span>
            <button
              type="button"
              onClick={() => { void persistExperience(experienceWrite.experience); }}
              className="shrink-0 font-medium underline"
            >
              Retry save
            </button>
          </div>
        )}
        <CohortPrompt
          mode="experience"
          demandTopics={snapshot.demandTopics}
          experienceDisabled={experienceWrite?.status === 'saving'}
          onExperience={(experience) => { void persistExperience(experience); }}
          onDemand={() => {}}
          onDismissDemand={() => {}}
        />
      </div>
    );
  }

  return (
    <UnifiedReviewBody
      {...props}
      initialBatch={discardInitialBatchRef.current ? null : props.initialBatch}
      initialCohortSnapshot={snapshot}
    />
  );
}

/**
 * How many upcoming figures to warm. Three covers the read-plus-grade window
 * at normal pace without letting a 20-item batch of clinical images stampede
 * the connection the current card is using.
 */
const UPCOMING_IMAGE_LOOKAHEAD = 3;

export function UnifiedReview(props: UnifiedReviewProps) {
  const isCohortHost = useCohortHost();
  // Reported 2026-09-15 as a layout defect: cohort stacked a title, a subtitle
  // and a link ABOVE the toolbar, pushing the question down roughly 150px, while
  // the primary host opens straight onto the card behind one 52px bar. On the
  // surface whose entire job is to show a question that is the worst place to
  // spend the first screen, and the title said nothing the deck itself does not.
  // Note the old header sat OUTSIDE CohortProfileBoundary, so it painted before
  // the profile gate resolved — which is much of why it dominated first paint.
  // The planner link moved into the toolbar's left group (see UnifiedReviewBody):
  // the slot the primary host gives its mode and rotation selectors, and which
  // cohort leaves empty because both of those require an authenticated learner.
  return isCohortHost
    ? <CohortProfileBoundary {...props} />
    : <UnifiedReviewBody {...props} />;
}

function UnifiedReviewBody({ rotations, week, rotationSizes, fetchSlots, feedMode = 'mixed', reviewFilter, itemType, topics, cluster = null, clusterScope = null, onFeedModeChange, onReviewModeChange, studyableRotations = [], enrollableRotations = [], examRotation = null, focusRotation = null, onFocusRotationChange, allowUnverifiedPack = false, initialBatch = null, loadTimer = null, cohortSingleTurn = false, initialCohortSnapshot = null }: UnifiedReviewProps & { initialCohortSnapshot?: CohortProfileSnapshot | null }) {
  const { data: authSession, status: authStatus } = useSession();
  const isCohortHost = useCohortHost();
  const isGuest = authStatus === 'unauthenticated';
  const isAuthenticated = authStatus === 'authenticated' && Boolean(authSession?.user?.id);
  const searchTopics = initialCohortSnapshot?.searchTopics ?? [];
  const [activeSearchTopicId, setActiveSearchTopicId] = useState<string | null>(null);
  const reviewUserKey = allowUnverifiedPack
    ? null
    : offlineUserKey(authSession?.user) ?? initialBatch?.ownerKey ?? null;
  const searchOwnerKeyRef = useRef(reviewUserKey);
  const reviewedAtUnmountRef = useRef(0);

  // Cohort uses this same visible-interval id as its durable turn journey.
  // Creating it before the review hook prevents a second, unlinked identity
  // for selection telemetry.
  const { sessionId, recordAnswerIntent } = useSessionLifecycle({
    disabled: allowUnverifiedPack,
    rotation: rotations.join(','),
    startMetadata: { rotations, feedMode },
    getEndMetadata: () => ({
      finalReviewedCount: reviewedAtUnmountRef.current,
    }),
  });

  // Session: items, navigation, loading. The account key binds the offline pack
  // (src/lib/offline/pack.ts) so a device never serves one user's cards to the next.
  const session = useReviewSession({
    rotations, week, rotationSizes, fetchSlots, feedMode, reviewFilter, itemType, topics, cluster, focusRotation,
    // The credentialless fallback must trust only the device owner record.
    // A stale next-auth value from a suspended tab must not override it.
    userKey: reviewUserKey,
    allowUnverifiedPack,
    initialBatch,
    loadTimer,
    singleTurn: cohortSingleTurn,
    cohortTurn: isCohortHost && cohortSingleTurn
      ? { journeyId: sessionId, searchTopicId: activeSearchTopicId }
      : null,
  });
  const {
    items, currentItem, currentIndex, loading, error, cohortTurnErrorCode, cohortTurnPending,
    stats, setStats,
    startTime, isExhausted, isFetchingMore, reviewTopRef,
    fetchItems, advanceToNext, advanceAndRefresh, handleGoBack, markSuppressed, registerResetCallback,
    shouldAutoScroll, scrollBehavior,
    newRemaining,
    servingOffline,
  } = session;

  // Warm the figures on the next few cards while the learner reads this one.
  // Review images are otherwise requested only when their card mounts, so a
  // card carrying a full-resolution clinical figure shows an empty box for
  // seconds - and under the sensitive-media gate that box has no height at
  // all until the bytes land, so the blur control collapses and then jumps
  // (recorded 2026-08-22). The batch already holds these URLs.
  usePrefetchImages(
    upcomingImageUrls(items, currentIndex, UPCOMING_IMAGE_LOOKAHEAD),
    !servingOffline,
  );

  useEffect(() => {
    if (searchOwnerKeyRef.current === reviewUserKey) return;
    searchOwnerKeyRef.current = reviewUserKey;
    setActiveSearchTopicId(null);
  }, [reviewUserKey]);

  // The pill is a DAILY total, not a session or deck total: what the learner has
  // done today against today's target. So it counts across every rotation they
  // study, not just the one this session happens to be drawing from.
  //
  // Passing only the session's own rotations broke on composed decks. NSx
  // owned no cards until 2026-09-16 — everything it served was declared for
  // it by another corpus — so `servableCardWhere({rotation:'nsx'})` matched
  // nothing, todayReviewed came back 0, and the pill read "1/80" to a learner
  // who had already reviewed for hours. Their work was never lost: it was
  // counted under anatomy and surgical-sciences, which the deck they were
  // sitting in did not name. It still borrows most of what it serves.
  //
  // Falling back to the session's rotations keeps guests and Cohort hosts (which
  // pass an empty studyable set) exactly as they were.
  const progressRotations = studyableRotations.length > 0 ? studyableRotations : rotations;
  const sessionProgress = useSessionProgress(progressRotations, {
    disabled: allowUnverifiedPack,
  });
  const {
    reviewed: serverReviewed,
    target,
    progress,
    incrementReviewed: incrementServerReviewed,
    coveragePercent, targetHit, bonusCount,
    perRotation,
    bookedExam,
  } = sessionProgress;
  // The API-backed daily counter is unavailable in the credentialless shell.
  // useReviewSession persists this local counter beside the tombstone ledger,
  // so a cold flight-mode relaunch resumes at N instead of displaying zero.
  const usingDeviceProgress = allowUnverifiedPack || servingOffline;
  const reviewed = usingDeviceProgress ? stats.total : serverReviewed;
  const incrementReviewed = useCallback((rotation?: string | null) => {
    if (!usingDeviceProgress) incrementServerReviewed(rotation);
  }, [incrementServerReviewed, usingDeviceProgress]);

  // Keep the unmount-metadata ref current after each commit. Writing a ref
  // during render trips react-hooks/refs; a no-deps effect runs after every
  // commit, so it is current when the lifecycle cleanup reads it.
  useEffect(() => {
    reviewedAtUnmountRef.current = reviewed;
  });
  // Fire target_crossed exactly once per session when the pill tips over
  // from below-target to at-or-above. The check runs on every render; the
  // ref blocks re-fires within the same session.
  const targetCrossedFiredRef = useRef(false);
  useEffect(() => {
    if (allowUnverifiedPack) return;
    if (targetCrossedFiredRef.current) return;
    if (target == null || target <= 0) return;
    if (reviewed < target) return;
    targetCrossedFiredRef.current = true;
    fetch('/api/study/session-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        eventType: 'target_crossed',
        rotation: rotations.join(','),
        metadata: { target, reviewedAtCross: reviewed },
      }),
      keepalive: true,
    }).catch(() => {});
  }, [allowUnverifiedPack, reviewed, target, sessionId, rotations]);

  // Submission error tracking
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [acknowledgedCohortAnswers, setAcknowledgedCohortAnswers] = useState(0);
  const consecutiveFailures = useRef(0);
  const onSubmitError = useCallback((msg: string) => {
    consecutiveFailures.current += 1;
    // Show error after 2 consecutive failures (first might be transient)
    if (consecutiveFailures.current >= 2) {
      setSubmitError(`Answers not saving: ${msg}`);
    }
  }, []);
  // Reset failure counter on successful submission + increment daily progress
  const onReviewWithReset = useCallback(() => {
    consecutiveFailures.current = 0;
    setSubmitError(null);
    if (isCohortHost && cohortSingleTurn && currentItem?.deliveryId) {
      setAcknowledgedCohortAnswers((count) => count + 1);
    }
    // Attribute the grade to the rotation it was graded in, so the drawer's row
    // for that rotation moves on this keystroke rather than at the next fetch.
    incrementReviewed(currentItem?.rotation);
  }, [cohortSingleTurn, currentItem?.deliveryId, currentItem?.rotation, incrementReviewed, isCohortHost]);

  // Card review: reveal, grade
  const card = useCardReview({
    currentItem, advanceToNext, setStats, registerResetCallback,
    onAnswerIntent: (isCorrect) => recordAnswerIntent({ isCorrect }),
  });
  const {
    revealedBlanks, blankCount, cardFullyRevealed, cardAnswerRef,
    handleReveal, handleRevealAll, handleCardGrade, handleCardContinue,
  } = card;

  // MCQ review: select, skip, confidence
  const mcq = useMcqReview({
    currentItem, currentIndex, startTime, advanceToNext, setStats,
    registerResetCallback, shouldAutoScroll, scrollBehavior,
    onReview: onReviewWithReset, onSubmitError,
    onAnswerIntent: (isCorrect) => recordAnswerIntent({ isCorrect }),
    opaqueAnswerEndpoint: isCohortHost ? '/api/cohort/answer' : undefined,
  });
  // Note: startTime, onReview, onSubmitError still used by handleSelectOption/handleMcqSkip in useMcqReview
  const {
    selectedOption, mcqResult, context, postAnswerAlt, postAnswerSourcePageUrl,
    expandedOptionExplanations,
    mcqConfidenceRef, mcqAnswerRef,
    handleSelectOption, handleMcqSkip, handleNext: handleLocalNext,
    toggleOptionExplanation, displayOptions,
    awaitingConfidence, handleOpaqueConfidence,
  } = mcq;

  const [cohortProfile, setCohortProfile] = useState<CohortFeedProfile | null>(
    initialCohortSnapshot?.profile ?? null,
  );
  const [cohortDeep, setCohortDeep] = useState(initialCohortSnapshot?.deep ?? false);
  const initialPublicGradedCountRef = useRef(initialCohortSnapshot?.publicGradedCount ?? 0);
  const cohortTopics = initialCohortSnapshot?.demandTopics ?? [];
  const [cohortWrite, setCohortWrite] = useState<CohortWriteState | null>(null);
  const cohortWriteInFlightRef = useRef(false);
  // The profile snapshot includes the server's durable public-answer count.
  // The local counter advances only after an opaque answer is acknowledged,
  // so this derives the same-page threshold without putting another network
  // round trip (or even a post-paint effect) between reveal and the prompt.
  // Keep this counter separate from session stats, which can be restored from
  // an offline continuity record.
  const effectiveCohortDeep = cohortDeep || Boolean(
    isCohortHost
    && cohortSingleTurn
    && initialPublicGradedCountRef.current + acknowledgedCohortAnswers >= 8,
  );

  const persistCohortWrite = useCallback(async (
    pending: PendingCohortWrite,
  ): Promise<boolean> => {
    if (cohortWriteInFlightRef.current) return false;
    cohortWriteInFlightRef.current = true;
    setCohortWrite({ ...pending, status: 'saving' });
    try {
      const res = await fetchWithDeadline('/api/cohort/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending.body),
        keepalive: true,
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!res.ok) {
        const failed = await res.json().catch(() => ({})) as { detail?: string; error?: string };
        throw new Error(failed.detail || failed.error || `HTTP ${res.status}`);
      }
      const next = await res.json().catch(() => null) as {
        profile?: CohortFeedProfile;
        deep?: boolean;
      } | null;
      // An OK response is the durable boundary. If response parsing is lost in
      // transit, apply the acknowledged patch locally instead of retrying a
      // non-idempotent profile event that the server already committed.
      setCohortProfile((current) => next?.profile ?? applyCohortPatchLocally(current, pending.body));
      if (typeof next?.deep === 'boolean') setCohortDeep(next.deep);
      setCohortWrite(null);
      if (pending.refreshAfterSave) {
        await advanceAndRefresh();
      }
      return true;
    } catch (error) {
      setCohortWrite({
        ...pending,
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not save your choice',
      });
      return false;
    } finally {
      cohortWriteInFlightRef.current = false;
    }
  }, [advanceAndRefresh]);

  const hookItems = items.filter((entry) => entry.decisionContext?.cohortHook);
  const isLastHookItem = Boolean(
    currentItem?.decisionContext?.cohortHook
    && hookItems.at(-1)?.id === currentItem.id,
  );

  const finalHookAnswered = Boolean(isLastHookItem && mcqResult);
  const hookNeedsSave = Boolean(
    isCohortHost
    && finalHookAnswered
    && !cohortProfile?.hookCompletedAt,
  );

  // Hook completion is committed as soon as the third answer is durable,
  // independently of the experience choice. A visitor who closes the tab at
  // the prompt will therefore return to the missing-experience gate instead of
  // receiving the three hook items again.
  useEffect(() => {
    if (!hookNeedsSave || cohortWrite) return;
    void persistCohortWrite({
      kind: 'hook',
      body: { hookCompleted: true },
      refreshAfterSave: false,
    });
  }, [cohortWrite, hookNeedsSave, persistCohortWrite]);

  const showExperiencePrompt = Boolean(
    isCohortHost
    && cohortProfile
    && !cohortProfile.explicit.experience
    && (finalHookAnswered || cohortProfile.hookCompletedAt),
  );
  const waitingForProfileAtHookGate = Boolean(
    isCohortHost && finalHookAnswered && !cohortProfile,
  );
  const onboardingWriteActive = Boolean(
    cohortWrite && (cohortWrite.kind === 'experience' || cohortWrite.kind === 'hook'),
  );
  const cohortOnboardingBlocked = Boolean(
    showExperiencePrompt
    || waitingForProfileAtHookGate
    || hookNeedsSave
    || onboardingWriteActive,
  );
  const showDemandPrompt = Boolean(
    mcqResult
    && cohortProfile?.explicit.experience
    && effectiveCohortDeep
    && !cohortProfile.explicit.demand
    && !isLastHookItem,
  );
  const cohortPromptBlocked = Boolean(
    cohortOnboardingBlocked
    || showDemandPrompt
    || cohortWrite?.kind === 'demand',
  );

  const handleSearchTopicSelect = useCallback((topicId: string) => {
    if (cohortTurnPending && !currentItem) return;
    setActiveSearchTopicId(topicId);
    if (cohortTurnErrorCode === 'topic_exhausted' || isExhausted || !currentItem) {
      void fetchItems(false, true, topicId);
    }
  }, [cohortTurnErrorCode, cohortTurnPending, currentItem, fetchItems, isExhausted]);

  const handleSearchTopicClear = useCallback(() => {
    if (cohortTurnPending && !currentItem) return;
    setActiveSearchTopicId(null);
    if (cohortTurnErrorCode === 'topic_exhausted' || isExhausted || !currentItem) {
      void fetchItems(false, true, null);
    }
  }, [cohortTurnErrorCode, cohortTurnPending, currentItem, fetchItems, isExhausted]);

  const handleExperience = useCallback((experience: CohortExperience) => {
    void persistCohortWrite({
      kind: 'experience',
      body: { experience },
      // A returning visitor whose hook was already complete may be looking at
      // a question selected without their experience prior. Retire it now.
      // Hook three itself remains visible so its explanation can be read; the
      // Continue action below performs the fresh server turn.
      refreshAfterSave: Boolean(cohortProfile?.hookCompletedAt && !isLastHookItem),
    });
  }, [cohortProfile?.hookCompletedAt, isLastHookItem, persistCohortWrite]);

  const handleNext = useCallback(() => {
    if (cohortPromptBlocked) return;
    if (
      isCohortHost
      && cohortSingleTurn
      && cohortProfile?.hookCompletedAt
      && cohortProfile.explicit.experience
    ) {
      void advanceAndRefresh();
      return;
    }
    handleLocalNext();
  }, [
    advanceAndRefresh,
    cohortPromptBlocked,
    cohortProfile?.explicit.experience,
    cohortProfile?.hookCompletedAt,
    cohortSingleTurn,
    handleLocalNext,
    isCohortHost,
  ]);

  // Shared grading hooks — handle API calls, state, offline queueing
  const getResponseTimeMs = useCallback(() => Date.now() - startTime, [startTime]);

  const cardGrading = useGrading({
    itemId: currentItem?.id ?? '',
    itemType: 'card',
    getResponseTimeMs,
    metadata: currentItem?.decisionContext,
    sessionId: currentItem?.sessionId,
    batchId: currentItem?.batchId,
    serveDecisionId: currentItem?.serveDecisionId,
    onGraded: (confidence) => {
      onReviewWithReset?.();
      handleCardGrade(confidence >= 3 ? 3 : 0);
    },
    onError: (msg) => onSubmitError?.(msg),
  });

  const mcqGrading = useGrading({
    itemId: currentItem?.id ?? '',
    itemType: 'question',
    onGraded: () => {
      handleNext();
    },
  });

  const videoGrading = useGrading({
    itemId: currentItem?.id ?? '',
    itemType: 'video',
    getResponseTimeMs,
    sessionId: currentItem?.sessionId,
    batchId: currentItem?.batchId,
    serveDecisionId: currentItem?.serveDecisionId,
    onGraded: (confidence) => {
      // Intentionally no recordAnswerIntent: the durable server event is
      // video_watched (exposure), not one of the canonical answer event types.
      setStats(prev => ({
        total: prev.total + 1,
        correct: confidence >= 3 ? prev.correct + 1 : prev.correct,
      }));
      onReviewWithReset?.();
      advanceToNext();
    },
    onError: (msg) => onSubmitError?.(msg),
  });

  // Reset grading state when item changes.
  // NOTE: Can't use currentIndex — advanceToNext trims items and keeps
  // currentIndex at UNDO_BUFFER (1), so the effect never re-fires after
  // the first couple of cards. Use item ID instead.
  const currentItemId = currentItem?.id;
  useEffect(() => {
    cardGrading.reset();
    mcqGrading.reset();
    videoGrading.reset();
    // Keyed on BOTH id and index. Index alone does not work, for the reason
    // above. ID alone does not either: the undo-buffer item is not added to
    // reviewedCardIdsRef until it is trimmed, so a refetch can hand back the
    // item sitting in that buffer and place it adjacent to itself. Stepping
    // between two same-id neighbours then changes no ID, the effect does not
    // fire, and a `saved` status survives onto a card the learner is looking at
    // — which disables the grade bar until a reload.
  }, [currentItemId, currentIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawer state (progress details panel)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showRotationChooser, setShowRotationChooser] = useState(false);

  // Flag state — F opens text input, Enter submits
  const flagging = useFlagging({ item: currentItem, registerResetCallback });
  const { flagMode, flagged, flagPending, flagMessage, authExpired, setFlagMode, setFlagMessage, handleFlagSubmit, closeFlag } = flagging;
  const handleReviewGoBack = useCallback(() => {
    // Opaque Cohort deliveries are one-shot receipts. Re-entering an answered
    // item would reset its local reveal state and invite a non-identical replay
    // that the server must reject, leaving the learner stranded.
    if (isCohortHost) return;

    // Clear grading state HERE rather than leaning on the currentItemId effect
    // below. Reported 2026-09-12: going back to a card repeatedly greys out the
    // grade bar, and only a page reload restores it.
    //
    // `ConfidenceButtons` disables itself while status is saving/saved/queued,
    // and the only thing that clears that status is an effect keyed on the item
    // ID. Going back can land on an item whose ID equals the one already
    // displayed — `advanceToNext` trims the list and pins currentIndex at the
    // undo buffer — and when it does, the effect never fires, the stale `saved`
    // status survives, and the grade bar is dead until a reload.
    //
    // Resetting on the way back is also the better invariant: going back IS an
    // intent to re-answer, so grading state should clear whether or not the ID
    // happened to change. The ID effect stays as the forward-navigation path.
    //
    // All three graders, not just the card one: the effect resets card, MCQ and
    // video together, so clearing only the reported case would leave the same
    // bug waiting behind the next MCQ.
    cardGrading.reset();
    mcqGrading.reset();
    videoGrading.reset();
    handleGoBack();
  }, [cardGrading, handleGoBack, isCohortHost, mcqGrading, videoGrading]);

  // Keyboard shortcuts
  useReviewKeyboard({
    // The required onboarding dialog owns the keyboard. Passing no item makes
    // Space/Enter/number shortcuts inert while its controls retain native
    // keyboard activation.
    currentItem: cohortPromptBlocked ? undefined : currentItem,
    cardFullyRevealed,
    mcqResult,
    flagMode,
    setFlagMode,
    handleReveal,
    handleCardGrade: cardGrading.grade,
    handleCardContinue,
    // `useGrading.grade()` early-returns while a grade is saving/saved/queued
    // and does not advance, so a grade keystroke in those states would do
    // nothing at all. Space is the primary key on this surface and used to
    // advance unconditionally; without this it goes dead whenever a stale
    // status is seated on a visible card. saved/queued mean the grade is
    // already recorded and saving means one is in flight, so advancing is the
    // correct response rather than a workaround.
    cardGradeBlocked: cardGrading.status === 'saving'
      || cardGrading.status === 'saved'
      || cardGrading.status === 'queued',
    handleSelectOption,
    handleMcqSkip,
    handleNext,
    handleMcqGrade: awaitingConfidence
      ? (confidence: number) => { void handleOpaqueConfidence(confidence); }
      : (currentItem?.deliveryId && mcqResult ? handleNext : mcqGrading.grade),
    handleVideoRate: videoGrading.grade,
    handleVideoContinue: advanceToNext,
    handleGoBack: handleReviewGoBack,
    handleRevealAll,
    awaitingConfidence,
    // g / b rate what is on screen. Uses the same poster as the thumb buttons
    // so the two cannot diverge.
    handleContentRating: (rating) => {
      if (!currentItem?.serveDecisionId) return;
      void postContentRating({
        itemType: currentItem.type === 'question' ? 'question' : 'card',
        itemId: currentItem.id,
        serveDecisionId: currentItem.serveDecisionId,
        rating,
        sourceComponent: currentItem.sourceComponent
          || (currentItem.type === 'question' ? 'MCQ' : 'Card'),
      });
    },
  });

  const item = currentItem;
  const displayItem = item?.type === 'question' && displayOptions
    ? { ...item, options: displayOptions }
    : item;

  // Skip truly unknown item types (failsafe)
  useEffect(() => {
    if (item && !KNOWN_TYPES.has(item.type)) {
      advanceToNext();
    }
  }, [item, advanceToNext]);

  useEffect(() => {
    // Don't auto-retry while the initial load is still in progress —
    // otherwise this aborts the initial fetch via the shared abort controller.
    if (!item && !isExhausted && !isFetchingMore && !loading) {
      fetchItems(true);
    }
  }, [item, isExhausted, isFetchingMore, loading, fetchItems]);

  // Loading — skeleton that mimics card layout
  if (loading) {
    return <LoadingSkeleton />;
  }

  // Error
  if (error) {
    const isAuthError = error.toLowerCase().includes('sign in') || error.toLowerCase().includes('session');
    const activeTopic = searchTopics.find((topic) => topic.id === activeSearchTopicId) ?? null;
    return (
      <div className="text-center py-8">
        <p role="alert" className="text-[var(--md-error)] mb-4">
          {cohortTurnErrorCode === 'topic_exhausted' && activeTopic
            ? `${activeTopic.label} is in the deck, but no fresh question fits your current level right now.`
            : error}
        </p>
        {isCohortHost && searchTopics.length > 0 && (
          <div className="mb-4 flex justify-center">
            <CohortSearchOverlay
              topics={searchTopics}
              activeTopicId={activeSearchTopicId}
              onSelect={handleSearchTopicSelect}
              onClear={handleSearchTopicClear}
              disabled={cohortTurnPending}
            />
          </div>
        )}
        {isAuthError ? (
          <Link href="/auth/signin" className="text-[var(--md-primary)] hover:underline">
            Sign in again
          </Link>
        ) : (
          <button
            onClick={cohortTurnErrorCode === 'topic_exhausted'
              ? handleSearchTopicClear
              : () => fetchItems()}
            className="text-[var(--md-primary)]"
          >
            {cohortTurnErrorCode === 'topic_exhausted' ? 'Back to discovery' : 'Retry'}
          </button>
        )}
      </div>
    );
  }

  // Empty — API returned no content. If exhausted, show a real message
  // instead of an infinite spinner.
  if (items.length === 0) {
    return (
      <SessionEmptyState
        isExhausted={isExhausted}
        feedMode={feedMode}
        itemType={itemType}
        newRemaining={newRemaining}
        showRefresh
        onFetch={() => fetchItems()}
        onFeedModeChange={onFeedModeChange}
        onReviewModeChange={onReviewModeChange}
      />
    );
  }

  // No more items — auto-fetch next batch or show session summary
  if (!item) {
    return (
      <SessionEmptyState
        isExhausted={isExhausted}
        feedMode={feedMode}
        itemType={itemType}
        newRemaining={newRemaining}
        stats={stats}
        focusRotation={focusRotation}
        canChooseFocus={!allowUnverifiedPack && studyableRotations.length > 0}
        isGuest={isGuest}
        onFetch={() => fetchItems()}
        onFeedModeChange={onFeedModeChange}
        onReviewModeChange={onReviewModeChange}
        onFocusRotationChange={onFocusRotationChange}
      />
    );
  }

  // Determine which buttons to show in sticky footer
  const showCardReveal = item.type === 'card' && !cardFullyRevealed;
  const showCardGrading = item.type === 'card' && cardFullyRevealed;
  const showMcqConfidence = item.type === 'question'
    && !cohortPromptBlocked
    && (awaitingConfidence || (!item.deliveryId && mcqResult));
  const showMcqContinue = item.type === 'question'
    && Boolean(item.deliveryId)
    && Boolean(mcqResult)
    && !cohortPromptBlocked;
  const showVideoRating = item.type === 'video';

  // Bottom padding must exceed the fixed footer height so content
  // doesn't hide behind it. Needed for every fixed-footer phase — including
  // the card REVEAL bar, so the tap target (reveal → grade) stays in one spot.
  // `sm:pb-48` is not redundant, it is the bug fix. The wrapper below carries
  // `sm:py-7`, and Tailwind emits that `padding-block` shorthand AFTER the bare
  // `pb-48` at equal specificity — so from 640px up the fixed grade bar has been
  // sitting over the bottom 28px of the card with nothing to clear it. That is
  // almost certainly the `bottomCoverPx: 79` on 76 of 88 user flags that
  // `hooks/reveal-scroll.ts` cites. Restating it inside the `sm` block puts it
  // after `sm:py-7` and it wins.
  //
  // 12rem clears the mobile stack (the ~5rem bottom nav plus the ~84px bar above
  // it), which is still what 640-767px needs since the nav only disappears at
  // `md`. From `md` the bar is alone, so 7rem clears it and hands the ~5rem
  // difference back to the figure pane.
  const bottomPaddingClass =
    (showCardReveal || showCardGrading || showMcqConfidence || showMcqContinue || showVideoRating)
      ? 'pb-48 sm:pb-48 md:pb-28'
      : '';

  // Prompt figures need two columns at `lg` from the start. A supplementary
  // figure widens the shell at reveal, so the answer and its figure sit side by
  // side instead of the figure landing below the fold. An answered MCQ counts
  // as revealed for the same reason a fully-revealed card does.
  // Both reveal states now clear during render on item change (useCardReview,
  // useMcqReview), so neither can describe the previous item on the first pass
  // after advancing. That matters here specifically: a stale reveal would open
  // the pane on a freshly served figured card before anything was revealed.
  const usesSidePane = itemUsesSidePane(
    item,
    item?.type === 'question' ? Boolean(mcqResult) : cardFullyRevealed,
  );

  if (showRotationChooser) {
    return (
      <RotationOnboarding
        rotations={enrollableRotations}
        onDone={() => window.location.reload()}
        onSkip={() => setShowRotationChooser(false)}
      />
    );
  }

  return (
    <div ref={reviewTopRef} data-review-scope={clusterScope ? 'topic' : undefined}>
      {/* Sticky toolbar: back, mode, rotation, pill, blur, flag.
          ONE row, FIXED height. The learner sees this bar 100+ times a day, so
          it must never grow: no `flex-wrap`, every leaf `whitespace-nowrap`,
          only the left group may shrink (its <select> truncates), and the
          phone-width labels are compact (glyph-only back/flag, "Blur" not
          "Blur images", "✓ +7" not "✓ 20 done · +7 bonus"). Reported
          2026-09-10 as the bar visibly thickening mid-session; the FOSS
          distribution scan rejects a learner name here, so the report is
          summarised. Guarded by e2e/review-toolbar-height.spec.ts. */}
      <div role="toolbar" aria-label="Review toolbar" className="sticky top-0 z-10 h-[52px] px-3 sm:px-4 flex flex-nowrap items-center justify-between gap-2 border-b border-[var(--md-outline-soft)] bg-[var(--md-surface)]/92 backdrop-blur shadow-[0_6px_18px_rgba(21,35,46,0.05)]">
        {/* No Home affordance here: `/` IS this review screen, so a header link
            to it was a guaranteed no-op — and it wore a hamburger glyph, which
            reads as "open a menu". Home stays reachable from the nav rail
            (desktop) and the bottom bar (mobile), one of which is always shown. */}
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2 text-sm text-[var(--md-on-surface-variant)]">
          {currentIndex > 0 && !isCohortHost && (
            <button
              onClick={handleReviewGoBack}
              className="shrink-0 whitespace-nowrap px-2 py-1 rounded-md hover:bg-[var(--md-surface-container-high)] transition-colors text-xs flex items-center gap-1"
              title="Go back (Z)"
              aria-label="Go back"
            >
              {'\u21A9'}<span className="hidden sm:inline"> back</span>
              <kbd className="hidden sm:inline text-[10px] opacity-40 font-mono">z</kbd>
            </button>
          )}
          {isCohortHost && (
            <Link
              href="/usmle/step1"
              // The visible label shortens to "Plan" at phone width to hold the
              // toolbar's fixed 52px single row, so the accessible name has to be
              // stated rather than inferred from the text — same reason the back
              // button above carries aria-label="Go back".
              aria-label="Plan a study session"
              className="shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-[var(--md-primary)] hover:bg-[var(--md-surface-container-high)] transition-colors"
            >
              Plan<span className="hidden sm:inline"> a study session</span>
            </Link>
          )}
          {isAuthenticated && onReviewModeChange && (
            <ReviewModeSelector
              feedMode={feedMode}
              reviewFilter={reviewFilter}
              itemType={itemType}
              onChange={onReviewModeChange}
              newRemaining={newRemaining}
            />
          )}
          {isAuthenticated && onFocusRotationChange && (
            <RotationFocusSelector
              options={studyableRotations}
              value={focusRotation}
              examRotation={examRotation}
              onChange={onFocusRotationChange}
              onChangeRotation={
                enrollableRotations.length > 0
                  ? () => setShowRotationChooser(true)
                  : undefined
              }
            />
          )}
        </div>

        {reviewed != null && (
          <ProgressPill
            reviewed={reviewed}
            target={target}
            coveragePercent={coveragePercent}
            progress={progress}
            targetHit={targetHit}
            bonusCount={bonusCount}
            onTap={() => setDrawerOpen(o => !o)}
          />
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <ImageBlurToggle />
          {isCohortHost && searchTopics.length > 0 && (
            <CohortSearchOverlay
              topics={searchTopics}
              activeTopicId={activeSearchTopicId}
              onSelect={handleSearchTopicSelect}
              onClear={handleSearchTopicClear}
              disabled={cohortPromptBlocked || cohortTurnPending}
            />
          )}
          {cohortProfile?.hookCompletedAt && (
            <Link
              href="/tech"
              className="text-xs text-[var(--md-on-surface-variant)] underline decoration-[var(--md-outline)] underline-offset-2 hover:text-[var(--md-on-surface)]"
            >
              How it&apos;s built
            </Link>
          )}
        <button
          onClick={() => setFlagMode(true)}
          disabled={flagPending}
          aria-label={flagged ? 'Flagged \u2014 press to add another flag' : flagPending ? 'Flag queued \u2014 sending\u2026' : 'Flag this item (F)'}
          className={`shrink-0 whitespace-nowrap text-xs px-2 py-1 rounded-md border border-transparent transition-colors ${
            flagged || flagPending
              ? 'bg-[var(--md-warning-container)] text-[var(--md-on-warning-container)] border-[var(--md-warning)]'
              : 'text-[var(--md-on-surface-variant)] hover:text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'
          }`}
          title={flagged ? 'Flagged \u2014 press to add another flag' : flagPending ? 'Flag queued \u2014 sending\u2026' : 'Flag this item (F)'}
        >
          {flagged ? (
            <>{'\u2691'}<span className="hidden sm:inline"> flagged</span></>
          ) : flagPending ? (
            <>{'\u29d6'}<span className="hidden sm:inline"> pending</span></>
          ) : (
            <span className="flex items-center gap-1">
              {'\u2690'}<span className="hidden sm:inline"> flag</span>
              <kbd className="hidden sm:inline text-[10px] opacity-40 font-mono">f</kbd>
            </span>
          )}
        </button>
        </div>
      </div>

      {/* A scoped session has to say so. Sits above the card rather than inside
          the toolbar: the toolbar's controls all CHANGE the session, and this
          reports what the session already is. */}
      {clusterScope && (
        <div className="px-4">
          <ReviewScopeBanner scope={clusterScope} />
        </div>
      )}

      {/* Session expired — a flag (or other write) hit a 401. Persistent across
          cards until re-sign-in; the queued write replays automatically after. */}
      {authExpired && (
        <div className="px-4">
          <SessionExpiredPrompt />
        </div>
      )}

      {/* Expandable drawer below header — per-rotation readiness rows */}
      {perRotation && perRotation.length > 0 && (
        <ProgressDrawer
          open={drawerOpen}
          reviewed={reviewed}
          target={target}
          perRotation={perRotation}
          bookedExam={bookedExam}
          sessionReviewed={stats.total}
          sessionAccuracy={stats.total > 0 ? Math.round(stats.correct / stats.total * 100) : 0}
          currentRotation={focusRotation}
        />
      )}

      {/* Submission error banner */}
      {submitError && (
        <div role="alert" className="bg-[var(--md-error-container)] text-[var(--md-on-error-container)] px-4 py-3 text-sm flex items-center justify-between">
          <span>{submitError}</span>
          <button
            onClick={() => { setSubmitError(null); consecutiveFailures.current = 0; }}
            className="ml-2 font-medium underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {isCohortHost && cohortWrite?.status === 'saving' && (
        <div role="status" className="fixed left-1/2 top-3 z-[70] -translate-x-1/2 rounded-full bg-[var(--md-on-surface)] px-4 py-2 text-sm text-[var(--md-surface)] shadow-lg">
          Saving your choice…
        </div>
      )}

      {isCohortHost && cohortWrite?.status === 'error' && (
        <div role="alert" className="fixed left-1/2 top-3 z-[70] flex w-[min(92vw,24rem)] -translate-x-1/2 items-center justify-between gap-3 rounded-lg bg-[var(--md-error-container)] px-4 py-3 text-sm text-[var(--md-on-error-container)] shadow-lg">
          <span>Your choice is still pending: {cohortWrite.message}</span>
          <button
            type="button"
            onClick={() => { void persistCohortWrite(cohortWrite); }}
            className="shrink-0 font-medium underline"
          >
            Retry save
          </button>
        </div>
      )}

      {!allowUnverifiedPack && (
        <div className="mx-auto max-w-2xl px-4 pt-4 sm:px-6">
          <GuestReviewLoginNudge
            isGuest={isGuest}
            reviewCount={stats.total}
          />
        </div>
      )}

      {/* Content area: the card is top-anchored — the conventional flashcard
          position (content starts near the top, grade ramp fixed at the bottom).
          A previous attempt to my-auto-centre short cards made them read as
          "floating in the middle of the screen", so that's reverted. */}
      <div className={`px-4 py-5 sm:px-6 sm:py-7 ${bottomPaddingClass}`}>
        <div className={`${reviewShellWidthClass(usesSidePane, reviewPaneKind(item))} mx-auto review-card-shell`}>
      {/* Flag overlay */}
      <FlagOverlay
        isOpen={flagMode}
        flagMessage={flagMessage}
        onSubmit={handleFlagSubmit}
        onClose={closeFlag}
        onFlagMessageChange={setFlagMessage}
      />

      {showExperiencePrompt && (
        <CohortPrompt
          mode="experience"
          demandTopics={cohortTopics}
          experienceDisabled={hookNeedsSave || cohortWrite?.kind === 'hook'}
          onExperience={handleExperience}
          onDemand={() => {}}
          onDismissDemand={() => {}}
        />
      )}
      {showDemandPrompt && (
        <CohortPrompt
          mode="demand"
          demandTopics={cohortTopics}
          onExperience={() => {}}
          onDemand={({ topics }) => {
            void persistCohortWrite({
              kind: 'demand',
              body: {
                demand: { topics },
              },
              refreshAfterSave: false,
            });
          }}
          onDismissDemand={() => {
            void persistCohortWrite({
              kind: 'demand',
              body: {
                demand: { topics: [], dismissed: true },
              },
              refreshAfterSave: false,
            });
          }}
        />
      )}


      {/* CARD */}
      {item.type === 'card' && (
        <CardItemView
          item={item}
          revealedBlanks={revealedBlanks}
          blankCount={blankCount}
          cardFullyRevealed={cardFullyRevealed}
          cardAnswerRef={cardAnswerRef}
          handleReveal={handleReveal}
          inlineReveal={false}
          onSuppress={(id) => { markSuppressed(id, 'card'); advanceToNext(); }}
        />
      )}

      {/* MCQ */}
      {displayItem?.type === 'question' && (
        <McqItemView
          item={displayItem}
          selectedOption={selectedOption}
          mcqResult={mcqResult}
          context={context}
          postAnswerAlt={postAnswerAlt}
          postAnswerSourcePageUrl={postAnswerSourcePageUrl}
          expandedOptionExplanations={expandedOptionExplanations}
          mcqAnswerRef={mcqAnswerRef}
          handleSelectOption={handleSelectOption}
          handleRevealAnswer={cohortPromptBlocked ? undefined : handleMcqSkip}
          toggleOptionExplanation={toggleOptionExplanation}
          selectedPending={!mcqResult && (selectedOption != null || awaitingConfidence)}
          interactionDisabled={cohortPromptBlocked}
          onSuppress={(id) => { markSuppressed(id, 'question'); advanceToNext(); }}
        />
      )}

      {/* VIDEO (short-form video for weak concepts) */}
      {item.type === 'video' && <VideoItemView key={item.id} item={item} />}

      {item.type === 'group' && item.steps && (
        <GroupReview
          groupType={item.groupType || 'ecg'}
          contextImageUrl={item.contextImageUrl}
          contextText={item.contextText}
          steps={item.steps}
          onComplete={(results: StepResult[], skipped: boolean) => {
            // Record group completion
            const correctCount = results.filter(r => r.correct).length;
            // Non-systematic groups sample a subset of the stored steps. Score
            // the steps actually presented, matching the server contract.
            const totalStepCount = results.length;
            setStats(prev => ({
              total: prev.total + 1,
              correct: correctCount >= totalStepCount / 2 ? prev.correct + 1 : prev.correct,
            }));
            // Durable: record attempt (queues for replay on offline/5xx) with
            // ServeDecision attribution.
            submitGroupAttempt({
              groupId: item.id,
              stepResults: results,
              skipped,
              sessionId: item.sessionId,
              batchId: item.batchId,
              serveDecisionId: item.serveDecisionId,
            });
            // submitGroupAttempt writes to the owner-bound outbox
            // synchronously; record intent only after that durable enqueue.
            recordAnswerIntent({ isCorrect: correctCount >= totalStepCount / 2 });
            advanceToNext();
          }}
          onSkip={() => {
            // Durable: record skip (queues for replay on offline/5xx) with
            // ServeDecision attribution.
            submitGroupAttempt({
              groupId: item.id,
              stepResults: [],
              skipped: true,
              sessionId: item.sessionId,
              batchId: item.batchId,
              serveDecisionId: item.serveDecisionId,
            });
            recordAnswerIntent({ isCorrect: false });
            advanceToNext();
          }}
        />
      )}
        </div>
      </div>

      {/* Card REVEAL bar — fixed at bottom (before revealing), in the SAME
          position as the grade ramp so the tap target never moves between
          reveal and grade (one consistent spot, esp. for mobile thumbs). */}
      {showCardReveal && (
        <div
          className="fixed left-0 right-0 md:left-20 z-50 p-4 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)]/94 backdrop-blur shadow-[0_-10px_28px_rgba(21,35,46,0.08)] safe-area-pb"
          style={{ bottom: 'var(--md-review-footer-bottom, 0px)' }}
        >
          <button
            onClick={handleReveal}
            className="review-choice max-w-2xl mx-auto w-full block min-h-[52px] py-3 rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] hover:bg-[var(--md-surface-container-highest)] text-[var(--md-on-surface)] font-medium transition-colors"
          >
            <RevealActionLabel item={item} remainingAnswers={blankCount - revealedBlanks} />
            {blankCount > 1 ? ` (${revealedBlanks}/${blankCount})` : ''}
          </button>
        </div>
      )}

      {/* Card grading buttons - fixed at bottom (after revealing) */}
      {showCardGrading && (
        <ConfidenceButtons mode="footer" onSelect={cardGrading.grade} selected={cardGrading.selected} status={cardGrading.status} />
      )}

      {/* MCQ confidence buttons - after answering (private) or after select (public opaque) */}
      {showMcqConfidence && (
        <ConfidenceButtons
          mode="footer"
          onSelect={awaitingConfidence
            ? (confidence) => { void handleOpaqueConfidence(confidence); }
            : mcqGrading.grade}
          selected={awaitingConfidence ? null : mcqGrading.selected}
          status={awaitingConfidence ? 'idle' : mcqGrading.status}
          wrapperRef={mcqConfidenceRef}
        />
      )}

      {showMcqContinue && (
        <div
          className="fixed left-0 right-0 md:left-20 z-50 p-4 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)]/94 backdrop-blur shadow-[0_-10px_28px_rgba(21,35,46,0.08)] safe-area-pb"
          style={{ bottom: 'var(--md-review-footer-bottom, 0px)' }}
        >
          <button
            onClick={handleNext}
            className="review-choice max-w-2xl mx-auto w-full block min-h-[52px] py-3 rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] hover:bg-[var(--md-surface-container-highest)] text-[var(--md-on-surface)] font-medium transition-colors"
          >
            Continue<span className="hidden sm:inline text-[var(--md-on-surface-variant)] font-normal"> · space</span>
          </button>
        </div>
      )}

      {/* Video rating buttons - fixed at bottom */}
      {showVideoRating && (
        <ConfidenceButtons mode="footer" onSelect={videoGrading.grade} selected={videoGrading.selected} status={videoGrading.status} />
      )}
    </div>
  );
}
