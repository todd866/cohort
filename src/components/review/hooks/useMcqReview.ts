import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { acknowledgeReview, enqueueReview } from '@/lib/review-queue';
import { submitWithRetry } from '@/lib/submit-with-retry';
import { genClientRequestId } from '@/lib/client-request-id';
import { answeredSlotKey, isRepeatAnswer, recordAnswer } from '@/lib/review/answered-slots';
import {
  captureOfflineOwner,
  isOfflineOwnerCurrent,
  subscribeOfflineOwner,
} from '@/lib/offline/owner';
import { captureReviewWriteClientContext } from '@/lib/review/review-write-observability';
import type { ReviewItem, ReviewStats } from './types';
import { peekRevealIntoView } from './reveal-scroll';
import { isPracticeFollowUpTurn } from './practice-follow-up-turn';
import { promptFigureSchema, toPromptFigureView, type PromptFigure, type PromptFigureView } from '@/lib/practice-exam/prompt-figure';

type ReviewQuestionOption = NonNullable<ReviewItem['options']>[number];

interface PendingOpaqueAnswer {
  deliveryId: string;
  endpoint: string;
  body: Record<string, unknown>;
  clientRequestId: string;
  ownerLease: ReturnType<typeof captureOfflineOwner>;
}

interface PendingScaffoldAnswer {
  body: Record<string, unknown>;
  clientRequestId: string;
  ownerLease: ReturnType<typeof captureOfflineOwner>;
}

interface ValidatedOpaqueReveal {
  deliveryId: string;
  selectedDisplayLabel: string | null;
  correctDisplayLabel: string;
  isCorrect: boolean;
  explanation: string | null;
  postAnswerAlt: string | null;
  postAnswerSourcePageUrl: string | null;
  postAnswerPromptFigure: PromptFigure | null;
  optionExplanations: Array<{ label: string; explanation: string | null }>;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return false;
  if (value.trim() !== value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate every server-owned field consumed by the reveal UI, plus the two
 * request identities that make an opaque retry safe to adopt. A 2xx response
 * is not an acknowledgement until this succeeds: a proxy/error page or stale
 * delivery response must leave the exact write-ahead row available to retry.
 */
function validatedOpaqueReveal(
  payload: unknown,
  pending: PendingOpaqueAnswer,
  displayOptions: ReviewQuestionOption[],
  promptFigure?: PromptFigureView,
): ValidatedOpaqueReveal | null {
  if (!isRecord(payload) || typeof payload.deduped !== 'boolean' || !isRecord(payload.answer)) {
    return null;
  }

  const answer = payload.answer;
  const selectedDisplayLabel = pending.body.selectedDisplayLabel;
  if (
    answer.deliveryId !== pending.deliveryId
    || answer.selectedDisplayLabel !== selectedDisplayLabel
    || typeof answer.isCorrect !== 'boolean'
    || typeof answer.correctDisplayLabel !== 'string'
    || (answer.explanation !== null && typeof answer.explanation !== 'string')
    || (
      answer.postAnswerAlt !== null
      && (
        typeof answer.postAnswerAlt !== 'string'
        || answer.postAnswerAlt.length === 0
        || answer.postAnswerAlt.length > 2_000
        || answer.postAnswerAlt.trim() !== answer.postAnswerAlt
      )
    )
    || (
      answer.postAnswerSourcePageUrl !== null
      && (
        pending.endpoint !== '/api/cohort/answer'
        || !isBoundedHttpsUrl(answer.postAnswerSourcePageUrl)
      )
    )
    || (answer.postAnswerSourcePageUrl === undefined)
    || !Array.isArray(answer.optionExplanations)
  ) {
    return null;
  }

  let postAnswerPromptFigure: PromptFigure | null = null;
  if (promptFigure || answer.postAnswerPromptFigure != null) {
    if (pending.endpoint !== '/api/practice-exam/follow-up/answer' || !promptFigure) return null;
    const parsed = promptFigureSchema.safeParse(answer.postAnswerPromptFigure);
    if (!parsed.success) return null;
    const view = toPromptFigureView(parsed.data);
    if (Object.keys(view).some(key => view[key as keyof PromptFigureView] !== promptFigure[key as keyof PromptFigureView])) return null;
    postAnswerPromptFigure = parsed.data;
  }

  const optionLabels = new Set(displayOptions.map((option) => option.label));
  if (!optionLabels.has(answer.correctDisplayLabel)) return null;
  if (
    answer.isCorrect
    !== (typeof selectedDisplayLabel === 'string'
      && selectedDisplayLabel === answer.correctDisplayLabel)
  ) {
    return null;
  }

  const optionExplanations: ValidatedOpaqueReveal['optionExplanations'] = [];
  for (const value of answer.optionExplanations) {
    if (
      !isRecord(value)
      || typeof value.label !== 'string'
      || !optionLabels.has(value.label)
      || (value.explanation !== null && typeof value.explanation !== 'string')
    ) {
      return null;
    }
    optionExplanations.push({
      label: value.label,
      explanation: value.explanation,
    });
  }

  return {
    deliveryId: answer.deliveryId,
    selectedDisplayLabel: answer.selectedDisplayLabel as string | null,
    correctDisplayLabel: answer.correctDisplayLabel,
    isCorrect: answer.isCorrect,
    explanation: answer.explanation,
    postAnswerAlt: answer.postAnswerAlt as string | null,
    postAnswerSourcePageUrl: answer.postAnswerSourcePageUrl as string | null,
    postAnswerPromptFigure,
    optionExplanations,
  };
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
  onReview?: () => void;
  /** Interval-local signal that a canonical answer write was attempted. */
  onAnswerIntent?: (isCorrect: boolean) => void;
  onSubmitError?: (error: string) => void;
  /** Host-gated facade for opaque answers; private MD3 keeps the canonical route. */
  opaqueAnswerEndpoint?: string;
  /** Required prompt pixels must be verified and decoded before scoring. */
  promptFigureReady?: boolean;
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
  onReview,
  onAnswerIntent,
  onSubmitError,
  opaqueAnswerEndpoint: hostAnswerEndpoint = '/api/usmle/step1/answer',
  promptFigureReady = false,
}: UseMcqReviewOptions) {
  const opaqueAnswerEndpoint = currentItem?.answerSource === 'practice-exam-follow-up'
    ? '/api/practice-exam/follow-up/answer'
    : hostAnswerEndpoint;
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [mcqResult, setMcqResult] = useState<{ isCorrect: boolean; correctOption: string } | null>(null);
  const [context, setContext] = useState<string>('');
  const [postAnswerAlt, setPostAnswerAlt] = useState<string | null>(null);
  const [postAnswerSourcePageUrl, setPostAnswerSourcePageUrl] = useState<string | null>(null);
  const [postAnswerPromptFigure, setPostAnswerPromptFigure] = useState<PromptFigure | null>(null);
  const [expandedOptionExplanations, setExpandedOptionExplanations] = useState<Set<string>>(new Set());
  const [opaqueSkipped, setOpaqueSkipped] = useState(false);
  const [opaqueWriteStatus, setOpaqueWriteStatus] = useState<'idle' | 'saving' | 'error' | 'owner-changed'>('idle');
  const opaqueWriteStatusRef = useRef<'idle' | 'saving' | 'error' | 'owner-changed'>('idle');
  opaqueWriteStatusRef.current = opaqueWriteStatus;
  const [optionExplanationMap, setOptionExplanationMap] = useState<Record<string, string>>({});

  const mcqConfidenceRef = useRef<HTMLDivElement | null>(null);
  const lastMcqAutoScrollId = useRef<string | null>(null);
  /** The post-answer explanation zone (result chip + context + figure). */
  const mcqAnswerRef = useRef<HTMLDivElement | null>(null);
  const submittingRef = useRef(false);
  const pendingOpaqueAnswerRef = useRef<PendingOpaqueAnswer | null>(null);
  const autoOpaqueDeliveryRef = useRef<string | null>(null);
  const currentItemIdentityRef = useRef(`${currentItem?.type ?? ''}:${currentItem?.id ?? ''}:${currentItem?.deliveryId ?? ''}`);
  const itemIdentityChangedRef = useRef(false);
  const activeOpaqueAttemptRef = useRef<symbol | null>(null);
  const pendingScaffoldAnswerRef = useRef<PendingScaffoldAnswer | null>(null);
  const scaffoldWriteInFlightRef = useRef(false);
  const [scaffoldWriteStatus, setScaffoldWriteStatus] = useState<'idle' | 'saving' | 'error' | 'owner-changed'>('idle');

  const currentQuestionId = currentItem?.type === 'question' ? currentItem.id : undefined;

  // Clear the answered state during render when the question changes, rather
  // than in the reset effect below. That effect runs a pass late, so a freshly
  // served question could render while the PREVIOUS question's result still
  // stood — which opens the side pane on an unrevealed figured question. The
  // reset callback still owns every other field and all explicit resets.
  const [lastQuestionId, setLastQuestionId] = useState(currentQuestionId);
  if (currentQuestionId !== lastQuestionId) {
    setLastQuestionId(currentQuestionId);
    setMcqResult(null);
  }
  const currentQuestionOptions = currentItem?.type === 'question' ? currentItem.options : undefined;
  const isOpaqueDelivery = Boolean(currentItem?.type === 'question' && currentItem.deliveryId);
  const displayOptions = useMemo(() => {
    if (!currentQuestionId || !currentQuestionOptions) return undefined;
    const base = isOpaqueDelivery
      ? currentQuestionOptions
      : avoidRepeatingLastCorrectPosition(currentQuestionId, currentQuestionOptions);
    if (Object.keys(optionExplanationMap).length === 0) return base;
    return base.map((option) => ({
      ...option,
      explanation: optionExplanationMap[option.label] ?? option.explanation,
    }));
  }, [currentQuestionId, currentQuestionOptions, isOpaqueDelivery, optionExplanationMap]);

  // Register reset callback
  useEffect(() => {
    return registerResetCallback(() => {
      setSelectedOption(null);
      setMcqResult(null);
      setContext('');
      setPostAnswerAlt(null);
      setPostAnswerSourcePageUrl(null);
      setPostAnswerPromptFigure(null);
      setExpandedOptionExplanations(new Set());
      setOpaqueSkipped(false);
      setOpaqueWriteStatus('idle');
      autoOpaqueDeliveryRef.current = null;
      setOptionExplanationMap({});
      pendingOpaqueAnswerRef.current = null;
      activeOpaqueAttemptRef.current = null;
      submittingRef.current = false;
      pendingScaffoldAnswerRef.current = null;
      scaffoldWriteInFlightRef.current = false;
      setScaffoldWriteStatus('idle');
    });
  }, [registerResetCallback]);

  // A frozen answer belongs to one delivery capability and one endpoint. Do
  // not let an old, late response unlock or reveal a newly rendered question.
  useEffect(() => {
    const pending = pendingOpaqueAnswerRef.current;
    if (
      pending
      && (pending.deliveryId !== currentItem?.deliveryId
        || pending.endpoint !== opaqueAnswerEndpoint)
    ) {
      pendingOpaqueAnswerRef.current = null;
      activeOpaqueAttemptRef.current = null;
      submittingRef.current = false;
    }
  }, [currentItem?.deliveryId, opaqueAnswerEndpoint]);

  // The parent normally calls the registered reset callback before advancing,
  // but keep the hook safe when a caller swaps the item directly. Otherwise a
  // stale selection can be interpreted as an answer to the next exact retest.
  useEffect(() => {
    const identity = `${currentItem?.type ?? ''}:${currentItem?.id ?? ''}:${currentItem?.deliveryId ?? ''}`;
    if (currentItemIdentityRef.current === identity) return;
    currentItemIdentityRef.current = identity;
    itemIdentityChangedRef.current = true;
    setSelectedOption(null);
    setMcqResult(null);
    setContext('');
    setOpaqueSkipped(false);
    setOpaqueWriteStatus('idle');
    autoOpaqueDeliveryRef.current = null;
  }, [currentItem?.deliveryId, currentItem?.id, currentItem?.type]);

  useEffect(() => {
    const pending = pendingScaffoldAnswerRef.current;
    if (pending && (pending.body.id !== currentItem?.id
      || pending.body.serveDecisionId !== currentItem?.serveDecisionId)) {
      pendingScaffoldAnswerRef.current = null;
      scaffoldWriteInFlightRef.current = false;
      setScaffoldWriteStatus('idle');
    }
  }, [currentItem?.id, currentItem?.serveDecisionId]);

  useEffect(() => subscribeOfflineOwner(() => {
    const scaffold = pendingScaffoldAnswerRef.current;
    const opaque = pendingOpaqueAnswerRef.current;
    if (opaqueWriteStatusRef.current === 'saving' && (!opaque || !isOfflineOwnerCurrent(opaque.ownerLease))) {
      setOpaqueWriteStatus('owner-changed');
    }
    if ((!scaffold || isOfflineOwnerCurrent(scaffold.ownerLease))
      && (!opaque || isOfflineOwnerCurrent(opaque.ownerLease))) return;
    // Keep the original owner's outbox row, but never rebind that frozen
    // answer to a new lease. A fresh feed/reload must reconcile it first.
    pendingScaffoldAnswerRef.current = null;
    pendingOpaqueAnswerRef.current = null;
    autoOpaqueDeliveryRef.current = null;
    activeOpaqueAttemptRef.current = null;
    scaffoldWriteInFlightRef.current = false;
    submittingRef.current = false;
    setScaffoldWriteStatus('owner-changed');
    setOpaqueWriteStatus('owner-changed');
  }), []);

  // Reveal remains immediate, but a bound scaffold cannot select its next
  // phase until the original, owner-bound canonical write is acknowledged.
  const submitScaffoldAnswer = useCallback(async (pending: PendingScaffoldAnswer) => {
    if (scaffoldWriteInFlightRef.current || !isOfflineOwnerCurrent(pending.ownerLease)) return;
    scaffoldWriteInFlightRef.current = true;
    setScaffoldWriteStatus('saving');
    const isCurrent = () => pendingScaffoldAnswerRef.current === pending
      && isOfflineOwnerCurrent(pending.ownerLease);
    try {
      const res = await submitWithRetry('/api/study/record', pending.body, { ownerLease: pending.ownerLease });
      if (!isCurrent()) return;
      const receipt: unknown = await res.json().catch(() => null);
      if (!isCurrent()) return;
      if (!res.ok || !isRecord(receipt) || receipt.success !== true
        || receipt.type !== 'question' || typeof receipt.isCorrect !== 'boolean'
        || typeof receipt.correctOption !== 'string') {
        throw new Error('Could not save this answer');
      }
      acknowledgeReview('/api/study/record', pending.clientRequestId, pending.ownerLease.ownerKey);
      pendingScaffoldAnswerRef.current = null;
      setScaffoldWriteStatus('idle');
    } catch (error) {
      if (!isCurrent()) return;
      setScaffoldWriteStatus('error');
      onSubmitError?.(String(error));
    } finally {
      // A reset or new question may already own a different in-flight write.
      if (pendingScaffoldAnswerRef.current === pending || pendingScaffoldAnswerRef.current === null) {
        scaffoldWriteInFlightRef.current = false;
      }
    }
  }, [onSubmitError]);

  const retryScaffoldAnswer = useCallback(() => {
    const pending = pendingScaffoldAnswerRef.current;
    if (pending) void submitScaffoldAnswer(pending);
  }, [submitScaffoldAnswer]);

  // Reset per-item auto-scroll state
  useEffect(() => {
    if (!mcqResult) lastMcqAutoScrollId.current = null;
  }, [mcqResult]);

  // After answering an MCQ, peek the EXPLANATION head into view when it is
  // still below the fold. Cards deliberately do NOT autoscroll — cloze
  // answers fill in place. Do NOT scroll just because a tall context/figure
  // trails below — the highlighted options (the answer) sit above this block,
  // and yanking past them is the bug (2026-08-04). Confidence buttons live in
  // a fixed footer, so they are never the scroll target.
  useEffect(() => {
    if (!currentItem || currentItem.type !== 'question') return;
    if (!mcqResult) return;
    if (!shouldAutoScroll()) return;

    const answerEl = mcqAnswerRef.current;
    if (!answerEl) return;
    if (lastMcqAutoScrollId.current === currentItem.id) return;

    lastMcqAutoScrollId.current = currentItem.id;
    requestAnimationFrame(() => {
      peekRevealIntoView(answerEl, scrollBehavior());
    });
  }, [currentIndex, currentItem, mcqResult, scrollBehavior, shouldAutoScroll]);

  // Advance to next item — confidence API call handled by useGrading
  const handleNext = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  // MCQ: select option (instant grading using preloaded data, or hold for
  // opaque public deliveries until confidence submits the Step 1 answer).
  const handleSelectOption = useCallback((label: string) => {
    if (mcqResult) return;
    if (submittingRef.current) return;

    if (!currentItem || currentItem.type !== 'question' || !displayOptions) return;
    if (currentItem.promptFigure && !promptFigureReady) return;

    if (currentItem.deliveryId) {
      if (pendingOpaqueAnswerRef.current?.deliveryId === currentItem.deliveryId) return;
      setSelectedOption(label);
      setOpaqueSkipped(false);
      return;
    }

    const selectedOptData = displayOptions.find(o => o.label === label);
    const isCorrect = selectedOptData?.isCorrect ?? false;
    const correctOption = displayOptions.find(o => o.isCorrect)?.label ?? '';

    // Going back to an answered question and choosing the same option again
    // shows the result but records nothing: it is a re-read, not a second
    // attempt. A different option is still recorded as a correction.
    const slot = answeredSlotKey({
      itemType: 'question',
      itemId: currentItem.id,
      serveDecisionId: currentItem.serveDecisionId,
      batchId: currentItem.batchId,
    });
    const answer = `option:${selectedOptData?.originalIndex ?? label}`;
    if (isRepeatAnswer(slot, answer)) {
      setSelectedOption(label);
      setMcqResult({ isCorrect, correctOption });
      if (currentItem.context) setContext(currentItem.context);
      return;
    }
    recordAnswer(slot, answer);

    const ownerLease = captureOfflineOwner();
    submittingRef.current = true;

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
    onAnswerIntent?.(isCorrect);
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

    if (isPracticeFollowUpTurn(currentItem)) {
      const pending = { body: mcqBody, clientRequestId, ownerLease };
      pendingScaffoldAnswerRef.current = pending;
      void submitScaffoldAnswer(pending);
      return;
    }

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
  }, [currentItem, displayOptions, mcqResult, startTime, setStats, onReview, onAnswerIntent, onSubmitError, submitScaffoldAnswer, promptFigureReady]);

  // MCQ: skip (space/enter) — reveal and defer without an accuracy judgment.
  const handleMcqSkip = useCallback(() => {
    if (mcqResult) return;
    if (submittingRef.current) return;

    if (!currentItem || currentItem.type !== 'question' || !displayOptions) return;

    if (currentItem.deliveryId) {
      if (pendingOpaqueAnswerRef.current?.deliveryId === currentItem.deliveryId) return;
      setSelectedOption(null);
      setOpaqueSkipped(true);
      return;
    }

    const correctOption = displayOptions.find(o => o.isCorrect)?.label ?? '';

    // Revisiting a skipped delivery reveals it without recording another skip.
    const slot = answeredSlotKey({
      itemType: 'question',
      itemId: currentItem.id,
      serveDecisionId: currentItem.serveDecisionId,
      batchId: currentItem.batchId,
    });
    if (isRepeatAnswer(slot, 'skip')) {
      setSelectedOption(null);
      setMcqResult({ isCorrect: false, correctOption });
      if (currentItem.context) setContext(currentItem.context);
      return;
    }
    recordAnswer(slot, 'skip');

    const ownerLease = captureOfflineOwner();
    submittingRef.current = true;

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
    writeLastCorrectDisplayPosition(currentItem.id, correctDisplayPosition);

    // Optimistic pill bump — see handleSelectOption for the same rationale.
    onReview?.();

    if (isPracticeFollowUpTurn(currentItem)) {
      const pending = { body: skipBody, clientRequestId, ownerLease };
      pendingScaffoldAnswerRef.current = pending;
      void submitScaffoldAnswer(pending);
      return;
    }

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
  }, [currentItem, displayOptions, mcqResult, startTime, onReview, onSubmitError, submitScaffoldAnswer]);

  const handleOpaqueConfidence = useCallback(async (confidence: number | null) => {
    if (mcqResult) return;
    if (submittingRef.current) return;
    if (!currentItem?.deliveryId || currentItem.type !== 'question') return;
    if (!displayOptions) return;
    // Exact exam retests use the normal question interaction: the selected
    // option is sent immediately, and the dedicated endpoint returns the
    // reveal. Legacy opaque deliveries still require an explicit confidence.
    if (confidence == null && currentItem.answerSource !== 'practice-exam-follow-up') return;
    if (selectedOption == null && !opaqueSkipped) return;
    if (!opaqueSkipped && currentItem.promptFigure && !promptFigureReady) return;

    submittingRef.current = true;
    setOpaqueWriteStatus('saving');
    let pending = pendingOpaqueAnswerRef.current;
    if (
      !pending
      || pending.deliveryId !== currentItem.deliveryId
      || pending.endpoint !== opaqueAnswerEndpoint
    ) {
      const ownerLease = captureOfflineOwner();
      const body = Object.freeze({
        deliveryId: currentItem.deliveryId,
        selectedDisplayLabel: opaqueSkipped ? null : selectedOption,
        responseTimeMs: Date.now() - startTime,
        confidence,
      }) as Record<string, unknown>;
      pending = {
        deliveryId: currentItem.deliveryId,
        endpoint: opaqueAnswerEndpoint,
        body,
        clientRequestId: genClientRequestId(),
        ownerLease,
      };
      pendingOpaqueAnswerRef.current = pending;

      // The delivery id is already the server's canonical idempotency key.
      // Keep one device-local outbox identity and one byte-stable request body
      // across all transport/parse retries for this delivery.
      enqueueReview(
        pending.endpoint,
        pending.body,
        pending.ownerLease.ownerKey,
        pending.clientRequestId,
      );
    }
    const attemptToken = Symbol('opaque-answer-attempt');
    activeOpaqueAttemptRef.current = attemptToken;

    try {
      const res = await submitWithRetry(pending.endpoint, pending.body, {
        ownerLease: pending.ownerLease,
      });
      if (!isOfflineOwnerCurrent(pending.ownerLease)) {
        setOpaqueWriteStatus('owner-changed');
        return;
      }
      if (
        pendingOpaqueAnswerRef.current !== pending
        || activeOpaqueAttemptRef.current !== attemptToken
      ) return;
      if (res.ok) {
        const payload = await res.json().catch(() => null) as unknown;
        if (!isOfflineOwnerCurrent(pending.ownerLease)) {
          setOpaqueWriteStatus('owner-changed');
          return;
        }
        if (
          pendingOpaqueAnswerRef.current !== pending
          || activeOpaqueAttemptRef.current !== attemptToken
        ) return;
        const answer = validatedOpaqueReveal(payload, pending, displayOptions, currentItem.promptFigure);
        if (
          !answer
          || pendingOpaqueAnswerRef.current !== pending
          || currentItem.deliveryId !== pending.deliveryId
        ) {
          setOpaqueWriteStatus('error');
          onSubmitError?.('Could not grade this question');
          return;
        }
        const isCorrect = answer.isCorrect;
        const correctOption = answer.correctDisplayLabel;
        setMcqResult({ isCorrect, correctOption });
        if (answer.explanation) setContext(answer.explanation);
        setPostAnswerAlt(answer.postAnswerAlt);
        setPostAnswerSourcePageUrl(answer.postAnswerSourcePageUrl);
        setPostAnswerPromptFigure(answer.postAnswerPromptFigure);
        const next: Record<string, string> = {};
        for (const row of answer.optionExplanations) {
          if (row.explanation) next[row.label] = row.explanation;
        }
        setOptionExplanationMap(next);
        // A reveal after skipping is not evidence of a wrong answer. In
        // particular it must not trigger exam scaffolding or depress the
        // session accuracy while the server defers the original miss.
        if (answer.selectedDisplayLabel !== null) {
          onAnswerIntent?.(isCorrect);
          setStats((prev) => ({
            total: prev.total + 1,
            correct: isCorrect ? prev.correct + 1 : prev.correct,
          }));
        }
        acknowledgeReview(
          pending.endpoint,
          pending.clientRequestId,
          pending.ownerLease.ownerKey,
        );
        pendingOpaqueAnswerRef.current = null;
        setOpaqueWriteStatus('idle');
        onReview?.();
        return;
      }

      const failed = await res.json().catch(() => ({})) as { detail?: string; error?: string };
      if (!isOfflineOwnerCurrent(pending.ownerLease)) return;
      setOpaqueWriteStatus('error');
      onSubmitError?.(failed.detail || failed.error || `HTTP ${res.status}`);
    } catch (err) {
      if (!isOfflineOwnerCurrent(pending.ownerLease)) return;
      if (
        pendingOpaqueAnswerRef.current !== pending
        || activeOpaqueAttemptRef.current !== attemptToken
      ) return;
      setOpaqueWriteStatus('error');
      onSubmitError?.(String(err));
    } finally {
      if (activeOpaqueAttemptRef.current === attemptToken) {
        activeOpaqueAttemptRef.current = null;
        submittingRef.current = false;
      }
    }
  }, [
    currentItem,
    displayOptions,
    mcqResult,
    opaqueSkipped,
    selectedOption,
    startTime,
    setStats,
    onReview,
    onAnswerIntent,
    onSubmitError,
    opaqueAnswerEndpoint,
    promptFigureReady,
  ]);

  const retryOpaqueAnswer = useCallback(() => {
    const pending = pendingOpaqueAnswerRef.current;
    if (pending && isOfflineOwnerCurrent(pending.ownerLease)) void handleOpaqueConfidence(
      typeof pending.body.confidence === 'number' ? pending.body.confidence : null,
    );
    else if (pending) setOpaqueWriteStatus('owner-changed');
  }, [handleOpaqueConfidence]);

  // Exact retests reveal after the learner selects an option. Keep the
  // server-owned answer and idempotent receipt path; only remove the extra
  // confidence-before-reveal step that made retests unlike normal questions.
  useEffect(() => {
    if (itemIdentityChangedRef.current) {
      itemIdentityChangedRef.current = false;
      return;
    }
    if (currentItem?.answerSource !== 'practice-exam-follow-up' || (!selectedOption && !opaqueSkipped) || mcqResult) return;
    if (!opaqueSkipped && currentItem.promptFigure && !promptFigureReady) return;
    if (autoOpaqueDeliveryRef.current === currentItem.deliveryId) return;
    autoOpaqueDeliveryRef.current = currentItem.deliveryId ?? null;
    void handleOpaqueConfidence(null);
  }, [currentItem?.answerSource, currentItem?.deliveryId, currentItem?.promptFigure, handleOpaqueConfidence, mcqResult, opaqueSkipped, promptFigureReady, selectedOption]);

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
    postAnswerAlt,
    postAnswerSourcePageUrl,
    postAnswerPromptFigure,
    expandedOptionExplanations,
    displayOptions,
    mcqConfidenceRef,
    mcqAnswerRef,
    awaitingConfidence: isOpaqueDelivery && currentItem?.answerSource !== 'practice-exam-follow-up'
      && !mcqResult && (selectedOption != null || opaqueSkipped),
    handleSelectOption,
    handleMcqSkip,
    handleNext,
    handleOpaqueConfidence,
    scaffoldWriteStatus,
    retryScaffoldAnswer,
    opaqueWriteStatus,
    retryOpaqueAnswer,
    toggleOptionExplanation,
  };
}
