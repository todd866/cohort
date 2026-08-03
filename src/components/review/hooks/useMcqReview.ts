import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { acknowledgeReview, enqueueReview } from '@/lib/review-queue';
import { submitWithRetry } from '@/lib/submit-with-retry';
import { genClientRequestId } from '@/lib/client-request-id';
import {
  captureOfflineOwner,
  isOfflineOwnerCurrent,
} from '@/lib/offline/owner';
import { captureReviewWriteClientContext } from '@/lib/review/review-write-observability';
import type { ReviewItem, ReviewStats } from './types';
import { revealScrollBlock } from './reveal-scroll';

type ReviewQuestionOption = NonNullable<ReviewItem['options']>[number];

const LAST_CORRECT_POSITION_KEY_PREFIX = 'md3:review:lastCorrectDisplayPosition:';

function optionLabelForIndex(index: number): string {
  return String.fromCharCode(65 + index);
}

function lastCorrectPositionKey(questionId: string): string {
  return `${LAST_CORRECT_POSITION_KEY_PREFIX}${questionId}`;
}

function readLastCorrectDisplayPosition(questionId: string): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(lastCorrectPositionKey(questionId));
    if (raw == null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeLastCorrectDisplayPosition(questionId: string, position: number): void {
  if (typeof window === 'undefined') return;
  if (!Number.isInteger(position) || position < 0) return;
  try {
    window.localStorage.setItem(lastCorrectPositionKey(questionId), String(position));
  } catch {
    // localStorage can be unavailable in private contexts; DB-side avoidance
    // still applies on the next fetch.
  }
}

function avoidRepeatingLastCorrectPosition(
  questionId: string,
  options: ReviewQuestionOption[]
): ReviewQuestionOption[] {
  const lastCorrectPosition = readLastCorrectDisplayPosition(questionId);
  if (lastCorrectPosition == null || lastCorrectPosition >= options.length) return options;

  const correctIndex = options.findIndex((option) => option.isCorrect);
  if (correctIndex === -1 || correctIndex !== lastCorrectPosition || options.length < 2) {
    return options;
  }

  const nextIndex = (correctIndex + 1) % options.length;
  const moved = [...options];
  [moved[correctIndex], moved[nextIndex]] = [moved[nextIndex], moved[correctIndex]];

  return moved.map((option, index) => ({
    ...option,
    label: optionLabelForIndex(index),
  }));
}

interface UseMcqReviewOptions {
  currentItem: ReviewItem | undefined;
  currentIndex: number;
  startTime: number;
  advanceToNext: () => void;
  setStats: React.Dispatch<React.SetStateAction<ReviewStats>>;
  registerResetCallback: (cb: () => void) => () => void;
  shouldAutoScroll: () => boolean;
  scrollBehavior: () => ScrollBehavior;
  isOffscreen: (element: HTMLElement, marginPx?: number) => boolean;
  onReview?: () => void;
  onSubmitError?: (error: string) => void;
}

export function useMcqReview({
  currentItem,
  currentIndex,
  startTime,
  advanceToNext,
  setStats,
  registerResetCallback,
  shouldAutoScroll,
  scrollBehavior,
  isOffscreen,
  onReview,
  onSubmitError,
}: UseMcqReviewOptions) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [mcqResult, setMcqResult] = useState<{ isCorrect: boolean; correctOption: string } | null>(null);
  const [context, setContext] = useState<string>('');
  const [expandedOptionExplanations, setExpandedOptionExplanations] = useState<Set<string>>(new Set());

  const mcqConfidenceRef = useRef<HTMLDivElement | null>(null);
  const lastMcqAutoScrollId = useRef<string | null>(null);
  /** The post-answer explanation zone (result chip + context + figure). */
  const mcqAnswerRef = useRef<HTMLDivElement | null>(null);
  const submittingRef = useRef(false);

  const currentQuestionId = currentItem?.type === 'question' ? currentItem.id : undefined;
  const currentQuestionOptions = currentItem?.type === 'question' ? currentItem.options : undefined;
  const displayOptions = useMemo(() => {
    if (!currentQuestionId || !currentQuestionOptions) return undefined;
    return avoidRepeatingLastCorrectPosition(currentQuestionId, currentQuestionOptions);
  }, [currentQuestionId, currentQuestionOptions]);

  // Register reset callback
  useEffect(() => {
    return registerResetCallback(() => {
      setSelectedOption(null);
      setMcqResult(null);
      setContext('');
      setExpandedOptionExplanations(new Set());
      submittingRef.current = false;
    });
  }, [registerResetCallback]);

  // Reset per-item auto-scroll state
  useEffect(() => {
    if (!mcqResult) lastMcqAutoScrollId.current = null;
  }, [mcqResult]);

  // After answering an MCQ, bring the EXPLANATION zone (context + figure) into
  // view. This used to target `mcqConfidenceRef` — but those confidence buttons
  // render in a POSITION-FIXED footer, so scrolling them into view is a no-op
  // and the explanation stayed below the fold. the reference learner, 2026-07-09: "the page should
  // autoscroll down to the context/image after I answer."
  useEffect(() => {
    if (!currentItem || currentItem.type !== 'question') return;
    if (!mcqResult) return;
    if (!shouldAutoScroll()) return;

    const answerEl = mcqAnswerRef.current;
    if (!answerEl) return;
    if (lastMcqAutoScrollId.current === currentItem.id) return;
    if (!isOffscreen(answerEl)) return;

    lastMcqAutoScrollId.current = currentItem.id;
    requestAnimationFrame(() => {
      // Same over-tall problem as the card reveal: the MCQ explanation block
      // (per-option rationales + context + figure) frequently exceeds the
      // viewport, and 'nearest' would align its bottom.
      answerEl.scrollIntoView({
        behavior: scrollBehavior(),
        block: revealScrollBlock(
          answerEl.getBoundingClientRect().height,
          window.innerHeight,
        ),
      });
    });
  }, [currentIndex, isOffscreen, currentItem, mcqResult, scrollBehavior, shouldAutoScroll]);

  // Advance to next item — confidence API call handled by useGrading
  const handleNext = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  // MCQ: select option (instant grading using preloaded data)
  const handleSelectOption = useCallback((label: string) => {
    if (mcqResult) return;
    if (submittingRef.current) return;

    if (!currentItem || currentItem.type !== 'question' || !displayOptions) return;

    const ownerLease = captureOfflineOwner();
    submittingRef.current = true;

    const selectedOptData = displayOptions.find(o => o.label === label);
    const isCorrect = selectedOptData?.isCorrect ?? false;
    const correctOption = displayOptions.find(o => o.isCorrect)?.label ?? '';

    // Record response in background, then revalidate due count
    // Send the original DB label (not the shuffled display label) so the
    // server grades against the correct option in the database.
    const originalLabel = selectedOptData?.originalIndex != null
      ? String.fromCharCode(65 + selectedOptData.originalIndex)
      : label;

    const correctDisplayPosition = displayOptions.findIndex(o => o.isCorrect);
    const selectedDisplayPosition = displayOptions.findIndex(o => o.label === label);
    const responseTimeMs = Date.now() - startTime;
    const clientRequestId = genClientRequestId();
    const mcqBody: Record<string, unknown> = {
      type: 'question',
      id: currentItem.id,
      selectedOption: originalLabel,
      responseTimeMs,
      correctDisplayPosition,
      selectedDisplayPosition,
      metadata: currentItem.decisionContext,
      // Idempotency key — dedups an outbox replay / retry of this MCQ grade.
      clientRequestId,
      ...captureReviewWriteClientContext(),
    };
    if (currentItem.sessionId != null) mcqBody.sessionId = currentItem.sessionId;
    if (currentItem.batchId != null) mcqBody.batchId = currentItem.batchId;
    if (currentItem.serveDecisionId != null) mcqBody.serveDecisionId = currentItem.serveDecisionId;

    // Persist before any UI callback can advance or throw. The row is removed
    // only after this exact owner-bound request is acknowledged.
    enqueueReview('/api/study/record', mcqBody, ownerLease.ownerKey);

    setSelectedOption(label);
    setMcqResult({ isCorrect, correctOption });
    if (currentItem.context) setContext(currentItem.context);
    setStats(prev => ({
      total: prev.total + 1,
      correct: isCorrect ? prev.correct + 1 : prev.correct,
    }));
    writeLastCorrectDisplayPosition(currentItem.id, correctDisplayPosition);

    // Bump the daily-progress pill OPTIMISTICALLY — before the API round-
    // trip. Matches the card-grading path (useGrading) which fires
    // onGraded immediately. Previously this bump only happened in the
    // .then() success branch, so a slow or failing /api/study/record left
    // the pill stuck at its page-load value even though the user had
    // clearly answered. Failed submissions are still queued offline via
    // enqueueReview; the next page-refresh reconciles via the API.
    onReview?.();

    submitWithRetry('/api/study/record', mcqBody, { ownerLease }).then(async (res) => {
      if (!isOfflineOwnerCurrent(ownerLease)) return;
      if (res.ok) {
        acknowledgeReview('/api/study/record', clientRequestId, ownerLease.ownerKey);
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (!isOfflineOwnerCurrent(ownerLease)) return;

        const msg = body.detail || body.error || `HTTP ${res.status}`;
        console.error('Question submission failed:', msg);
        onSubmitError?.(msg);
      }
    }).catch((err) => {
      if (!isOfflineOwnerCurrent(ownerLease)) return;

      console.error('Question submission failed:', err);
      onSubmitError?.(String(err));
    });
  }, [currentItem, displayOptions, mcqResult, startTime, setStats, onReview, onSubmitError]);

  // MCQ: skip (space/enter) - show answer and record as didn't know
  const handleMcqSkip = useCallback(() => {
    if (mcqResult) return;
    if (submittingRef.current) return;

    if (!currentItem || currentItem.type !== 'question' || !displayOptions) return;

    const ownerLease = captureOfflineOwner();
    submittingRef.current = true;

    const correctOption = displayOptions.find(o => o.isCorrect)?.label ?? '';

    // Record skip in background, then revalidate due count
    const correctDisplayPosition = displayOptions.findIndex(o => o.isCorrect);
    const responseTimeMs = Date.now() - startTime;
    const clientRequestId = genClientRequestId();
    const skipBody: Record<string, unknown> = {
      type: 'question',
      id: currentItem.id,
      selectedOption: null,
      responseTimeMs,
      correctDisplayPosition,
      selectedDisplayPosition: null,
      metadata: currentItem.decisionContext,
      clientRequestId,
      ...captureReviewWriteClientContext(),
    };
    if (currentItem.sessionId != null) skipBody.sessionId = currentItem.sessionId;
    if (currentItem.batchId != null) skipBody.batchId = currentItem.batchId;
    if (currentItem.serveDecisionId != null) skipBody.serveDecisionId = currentItem.serveDecisionId;

    enqueueReview('/api/study/record', skipBody, ownerLease.ownerKey);

    setSelectedOption(null);
    setMcqResult({ isCorrect: false, correctOption });
    if (currentItem.context) setContext(currentItem.context);
    setStats(prev => ({
      total: prev.total + 1,
      correct: prev.correct,
    }));
    writeLastCorrectDisplayPosition(currentItem.id, correctDisplayPosition);

    // Optimistic pill bump — see handleSelectOption for the same rationale.
    onReview?.();

    submitWithRetry('/api/study/record', skipBody, { ownerLease }).then(async (res) => {
      if (!isOfflineOwnerCurrent(ownerLease)) return;
      if (res.ok) {
        acknowledgeReview('/api/study/record', clientRequestId, ownerLease.ownerKey);
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (!isOfflineOwnerCurrent(ownerLease)) return;

        const msg = body.detail || body.error || `HTTP ${res.status}`;
        console.error('Question skip submission failed:', msg);
        onSubmitError?.(msg);
      }
    }).catch((err) => {
      if (!isOfflineOwnerCurrent(ownerLease)) return;

      console.error('Question skip submission failed:', err);
      onSubmitError?.(String(err));
    });
  }, [currentItem, displayOptions, mcqResult, startTime, setStats, onReview, onSubmitError]);

  const toggleOptionExplanation = useCallback((label: string) => {
    setExpandedOptionExplanations((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }, []);

  return {
    selectedOption,
    mcqResult,
    context,
    expandedOptionExplanations,
    displayOptions,
    mcqConfidenceRef,
    mcqAnswerRef,
    handleSelectOption,
    handleMcqSkip,
    handleNext,
    toggleOptionExplanation,
  };
}
