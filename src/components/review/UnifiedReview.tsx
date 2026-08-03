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
import { useSessionProgress } from './hooks/useSessionProgress';
import { useSessionLifecycle } from './hooks/useSessionLifecycle';
import { useFlagging } from './hooks/useFlagging';
import { SessionExpiredPrompt } from '@/components/content/SessionExpiredPrompt';
import { submitGroupAttempt } from '@/lib/group-attempt-submit';
import type { StepResult } from '@/lib/question-groups/types';
import { useGrading } from '@/hooks/useGrading';
import { offlineUserKey } from '@/lib/offline/pack';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import type { ReviewFilter } from '@/lib/review/review-intent';
import { GuestReviewLoginNudge } from '@/components/ui/LoginNudge';

import { RotationFocusSelector } from './RotationFocusSelector';
import { FlagOverlay } from './FlagOverlay';
import { ProgressPill } from './ProgressPill';
import { ProgressDrawer } from './ProgressDrawer';
import { SessionEmptyState } from './SessionEmptyState';
import { LoadingSkeleton } from './LoadingSkeleton';
import { CardItemView } from './CardItemView';
import { McqItemView } from './McqItemView';
import { VideoItemView } from './VideoItemView';

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
  onFeedModeChange?: (next: ReviewFeedMode) => void;
  onReviewModeChange?: (next: ReviewMode) => void;
  /** Enrolled studyable rotations (drives the focus selector + its gating). */
  studyableRotations?: string[];
  /** Currently focused rotation (null = All / blended feed). */
  focusRotation?: string | null;
  onFocusRotationChange?: (next: string | null) => void;
  /** Set by the offline fallback page — see useReviewSession's option of the same name. */
  allowUnverifiedPack?: boolean;
  /** Authenticated first batch assembled for this exact server render. */
  initialBatch?: InitialReviewBatch | null;
}

export function UnifiedReview({ rotations, week, rotationSizes, fetchSlots, feedMode = 'mixed', reviewFilter, onFeedModeChange, onReviewModeChange, studyableRotations = [], focusRotation = null, onFocusRotationChange, allowUnverifiedPack = false, initialBatch = null }: UnifiedReviewProps) {
  const { data: authSession, status: authStatus } = useSession();
  const isGuest = authStatus === 'unauthenticated';
  const isAuthenticated = authStatus === 'authenticated' && Boolean(authSession?.user?.id);
  // Session: items, navigation, loading. The account key binds the offline pack
  // (src/lib/offline/pack.ts) so a device never serves one user's cards to the next.
  const session = useReviewSession({
    rotations, week, rotationSizes, fetchSlots, feedMode, reviewFilter, focusRotation,
    // The credentialless fallback must trust only the device owner record.
    // A stale next-auth value from a suspended tab must not override it.
    userKey: allowUnverifiedPack
      ? null
      : offlineUserKey(authSession?.user) ?? initialBatch?.ownerKey ?? null,
    allowUnverifiedPack,
    initialBatch,
  });
  const {
    items, currentItem, currentIndex, loading, error, stats, setStats,
    startTime, isExhausted, isFetchingMore, reviewTopRef,
    fetchItems, advanceToNext, handleGoBack, markSuppressed, registerResetCallback,
    shouldAutoScroll, scrollBehavior, isOffscreen,
    newRemaining,
    servingOffline,
  } = session;

  // Pass the FULL rotations array so the pill sums reviews + target across
  // all active rotations (e.g. cah + pwh for research-block users).
  const sessionProgress = useSessionProgress(rotations, {
    disabled: allowUnverifiedPack,
  });
  const {
    reviewed: serverReviewed,
    target,
    progress,
    incrementReviewed: incrementServerReviewed,
    coveragePercent, targetHit, bonusCount,
    perRotation,
  } = sessionProgress;
  // The API-backed daily counter is unavailable in the credentialless shell.
  // useReviewSession persists this local counter beside the tombstone ledger,
  // so a cold flight-mode relaunch resumes at N instead of displaying zero.
  const usingDeviceProgress = allowUnverifiedPack || servingOffline;
  const reviewed = usingDeviceProgress ? stats.total : serverReviewed;
  const incrementReviewed = useCallback(() => {
    if (!usingDeviceProgress) incrementServerReviewed();
  }, [incrementServerReviewed, usingDeviceProgress]);

  // Session-lifecycle analytics: one sessionId per visible interval. Hidden,
  // pagehide, or unmount ends the active ID; a visible resume starts a fresh
  // one. Refs keep teardown metadata current without restarting on prop changes.
  const statsRef = useRef(stats);
  const reviewedAtUnmountRef = useRef(reviewed);
  // Keep the unmount-metadata refs current after each commit. Writing a ref
  // during render trips react-hooks/refs; a no-deps effect runs after every
  // commit, so the refs are current when the lifecycle cleanup reads them.
  useEffect(() => {
    statsRef.current = stats;
    reviewedAtUnmountRef.current = reviewed;
  });
  const { sessionId } = useSessionLifecycle({
    disabled: allowUnverifiedPack,
    rotation: rotations.join(','),
    startMetadata: { rotations, feedMode },
    getEndMetadata: () => ({
      itemsAnswered: statsRef.current.total,
      correctCount: statsRef.current.correct,
      finalReviewedCount: reviewedAtUnmountRef.current,
    }),
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
    incrementReviewed();
  }, [incrementReviewed]);

  // Card review: reveal, grade
  const card = useCardReview({
    currentItem, advanceToNext, setStats, registerResetCallback,
    shouldAutoScroll, scrollBehavior, isOffscreen,
  });
  const {
    revealedBlanks, blankCount, cardFullyRevealed, cardAnswerRef,
    handleReveal, handleCardGrade, handleCardContinue,
  } = card;

  // MCQ review: select, skip, confidence
  const mcq = useMcqReview({
    currentItem, currentIndex, startTime, advanceToNext, setStats,
    registerResetCallback, shouldAutoScroll, scrollBehavior, isOffscreen,
    onReview: onReviewWithReset, onSubmitError,
  });
  // Note: startTime, onReview, onSubmitError still used by handleSelectOption/handleMcqSkip in useMcqReview
  const {
    selectedOption, mcqResult, context, expandedOptionExplanations, mcqConfidenceRef, mcqAnswerRef,
    handleSelectOption, handleMcqSkip, handleNext,
    toggleOptionExplanation, displayOptions,
  } = mcq;

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
  }, [currentItemId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawer state (progress details panel)
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Flag state — F opens text input, Enter submits
  const flagging = useFlagging({ item: currentItem, registerResetCallback });
  const { flagMode, flagged, flagPending, flagMessage, authExpired, setFlagMode, setFlagMessage, handleFlagSubmit, closeFlag } = flagging;

  // Keyboard shortcuts
  useReviewKeyboard({
    currentItem,
    cardFullyRevealed,
    mcqResult,
    flagMode,
    setFlagMode,
    handleReveal,
    handleCardGrade: cardGrading.grade,
    handleCardContinue,
    handleSelectOption,
    handleMcqSkip,
    handleNext,
    handleMcqGrade: mcqGrading.grade,
    handleVideoRate: videoGrading.grade,
    handleVideoContinue: advanceToNext,
    handleGoBack,
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
    return (
      <div className="text-center py-8">
        <p role="alert" className="text-[var(--md-error)] mb-4">{error}</p>
        {isAuthError ? (
          <Link href="/auth/signin" className="text-[var(--md-primary)] hover:underline">
            Sign in again
          </Link>
        ) : (
          <button onClick={() => fetchItems()} className="text-[var(--md-primary)]">Retry</button>
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
        newRemaining={newRemaining}
        showRefresh
        onFetch={() => fetchItems()}
        onFeedModeChange={onFeedModeChange}
      />
    );
  }

  // No more items — auto-fetch next batch or show session summary
  if (!item) {
    return (
      <SessionEmptyState
        isExhausted={isExhausted}
        feedMode={feedMode}
        newRemaining={newRemaining}
        stats={stats}
        focusRotation={focusRotation}
        canChooseFocus={!allowUnverifiedPack && studyableRotations.length > 0}
        isGuest={isGuest}
        onFetch={() => fetchItems()}
        onFeedModeChange={onFeedModeChange}
        onFocusRotationChange={onFocusRotationChange}
      />
    );
  }

  // Determine which buttons to show in sticky footer
  const showCardReveal = item.type === 'card' && !cardFullyRevealed;
  const showCardGrading = item.type === 'card' && cardFullyRevealed;
  const showMcqConfidence = item.type === 'question' && mcqResult;
  const showVideoRating = item.type === 'video';

  // Bottom padding must exceed the fixed footer height so content
  // doesn't hide behind it. Needed for every fixed-footer phase — including
  // the card REVEAL bar, so the tap target (reveal → grade) stays in one spot.
  const bottomPaddingClass =
    (showCardReveal || showCardGrading || showMcqConfidence || showVideoRating)
      ? 'pb-48'
      : '';

  return (
    <div ref={reviewTopRef}>
      {/* Sticky header: home + back, pill, flag */}
      <div className="sticky top-0 z-10 min-h-[52px] px-4 py-2 flex items-center justify-between border-b border-[var(--md-outline-soft)] bg-[var(--md-surface)]/92 backdrop-blur shadow-[0_6px_18px_rgba(21,35,46,0.05)]">
        {/* No Home affordance here: `/` IS this review screen, so a header link
            to it was a guaranteed no-op — and it wore a hamburger glyph, which
            reads as "open a menu". Home stays reachable from the nav rail
            (desktop) and the bottom bar (mobile), one of which is always shown. */}
        <div className="flex items-center gap-2 text-sm text-[var(--md-on-surface-variant)]">
          {currentIndex > 0 && (
            <button
              onClick={handleGoBack}
              className="px-2 py-1 rounded-md hover:bg-[var(--md-surface-container-high)] transition-colors text-xs flex items-center gap-1"
              title="Go back (Z)"
            >
              {'\u21A9'} back
              <kbd className="text-[10px] opacity-40 font-mono">z</kbd>
            </button>
          )}
          {isAuthenticated && onReviewModeChange && (
            <ReviewModeSelector
              feedMode={feedMode}
              reviewFilter={reviewFilter}
              onChange={onReviewModeChange}
              newRemaining={newRemaining}
            />
          )}
          {isAuthenticated && onFocusRotationChange && (
            <RotationFocusSelector
              options={studyableRotations}
              value={focusRotation}
              onChange={onFocusRotationChange}
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

        <button
          onClick={() => setFlagMode(true)}
          disabled={flagPending}
          className={`text-xs px-2 py-1 rounded-md border border-transparent transition-colors ${
            flagged || flagPending
              ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60'
              : 'text-[var(--md-on-surface-variant)] hover:text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'
          }`}
          title={flagged ? 'Flagged \u2014 press to add another flag' : flagPending ? 'Flag queued \u2014 sending\u2026' : 'Flag this item (F)'}
        >
          {flagged ? '\u2691 flagged' : flagPending ? '\u29d6 pending' : (
            <span className="flex items-center gap-1">
              {'\u2690'} flag
              <kbd className="text-[10px] opacity-40 font-mono">f</kbd>
            </span>
          )}
        </button>
      </div>

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
          sessionReviewed={stats.total}
          sessionAccuracy={stats.total > 0 ? Math.round(stats.correct / stats.total * 100) : 0}
        />
      )}

      {/* Submission error banner */}
      {submitError && (
        <div role="alert" className="bg-[var(--md-error-container,#fce4ec)] text-[var(--md-on-error-container,#b71c1c)] px-4 py-3 text-sm flex items-center justify-between">
          <span>{submitError}</span>
          <button
            onClick={() => { setSubmitError(null); consecutiveFailures.current = 0; }}
            className="ml-2 font-medium underline"
          >
            Dismiss
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
        <div className="max-w-2xl mx-auto review-card-shell">
      {/* Flag overlay */}
      <FlagOverlay
        isOpen={flagMode}
        flagMessage={flagMessage}
        onSubmit={handleFlagSubmit}
        onClose={closeFlag}
        onFlagMessageChange={setFlagMessage}
      />


      {/* CARD */}
      {item.type === 'card' && (
        <CardItemView
          item={item}
          revealedBlanks={revealedBlanks}
          blankCount={blankCount}
          cardFullyRevealed={cardFullyRevealed}
          cardAnswerRef={cardAnswerRef}
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
          expandedOptionExplanations={expandedOptionExplanations}
          mcqAnswerRef={mcqAnswerRef}
          handleSelectOption={handleSelectOption}
          toggleOptionExplanation={toggleOptionExplanation}
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
          className="fixed left-0 right-0 z-50 p-4 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)]/94 backdrop-blur shadow-[0_-10px_28px_rgba(21,35,46,0.08)] safe-area-pb"
          style={{ bottom: 'var(--md-review-footer-bottom, 0px)' }}
        >
          <button
            onClick={handleReveal}
            className="review-choice max-w-2xl mx-auto w-full block min-h-[52px] py-3 rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] hover:bg-[var(--md-surface-container-highest)] text-[var(--md-on-surface)] font-medium transition-colors"
          >
            Reveal {blankCount > 1 ? `(${revealedBlanks}/${blankCount})` : ''}<span className="hidden sm:inline text-[var(--md-on-surface-variant)] font-normal"> · space</span>
          </button>
        </div>
      )}

      {/* Card grading buttons - fixed at bottom (after revealing) */}
      {showCardGrading && (
        <ConfidenceButtons mode="footer" onSelect={cardGrading.grade} selected={cardGrading.selected} status={cardGrading.status} />
      )}

      {/* MCQ confidence buttons - fixed at bottom (after answering) */}
      {showMcqConfidence && (
        <ConfidenceButtons mode="footer" onSelect={mcqGrading.grade} selected={mcqGrading.selected} status={mcqGrading.status} wrapperRef={mcqConfidenceRef} />
      )}

      {/* Video rating buttons - fixed at bottom */}
      {showVideoRating && (
        <ConfidenceButtons mode="footer" onSelect={videoGrading.grade} selected={videoGrading.selected} status={videoGrading.status} />
      )}
    </div>
  );
}
