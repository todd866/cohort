'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useMCQTracking } from '@/hooks/useTracking';
import { useGrading } from '@/hooks/useGrading';
import { type MCQOption, buildMcqAttemptPayload, type McqAttemptPayload } from '@/components/content/mcq-utils';

// ─── Types ──────────────────────────────────────────────────────

export interface MCQSubmitData {
  label: string;
  correct: boolean;
  responseTimeMs: number | undefined;
  attemptPayload: McqAttemptPayload;
}

export interface UseMCQInteractionOptions {
  questionId: string;
  correctLabel: string;
  shuffledOptions: MCQOption[];
  /** Called when the user selects an answer — handle API submission here */
  onSubmit: (data: MCQSubmitData) => void;
  /** Called after reset — handle component-specific cleanup here */
  onReset?: () => void;
}

export interface UseMCQInteractionReturn {
  selectedAnswer: string | null;
  showResult: boolean;
  hasAnswered: boolean;
  isCorrect: boolean;
  handleOptionClick: (label: string) => void;
  handleReset: () => void;
  /** Confidence grading */
  gradeConfidence: (confidence: number) => void;
  confidenceSelected: number | null;
  confidenceStatus: 'idle' | 'saving' | 'saved' | 'queued' | 'error';
}

// ─── Hook ───────────────────────────────────────────────────────

export function useMCQInteraction({
  questionId,
  correctLabel,
  shuffledOptions,
  onSubmit,
  onReset,
}: UseMCQInteractionOptions): UseMCQInteractionReturn {
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [hasAnswered, setHasAnswered] = useState(false);
  // Ref initialised to 0 at render time; the useEffect below (which fires
  // on mount and on every questionId change) sets the real start timestamp.
  // Submit handler falls back to Date.now() if ref hasn't been stamped yet.
  const questionStartedAtRef = useRef<number>(0);
  const submittingRef = useRef(false);

  const { onAnswer } = useMCQTracking(questionId);
  const {
    grade: gradeConfidence,
    selected: confidenceSelected,
    status: confidenceStatus,
    reset: resetConfidence,
  } = useGrading({ itemId: questionId, itemType: 'question' });

  // Reset state when the question changes. React-approved 'reset state
  // while rendering' pattern for state only — refs are updated in the
  // useEffect below (refs can't be written during render).
  const [lastQuestionId, setLastQuestionId] = useState(questionId);
  if (lastQuestionId !== questionId) {
    setLastQuestionId(questionId);
    setSelectedAnswer(null);
    setShowResult(false);
    setHasAnswered(false);
    resetConfidence();
  }
  // Stamp the question-start timestamp and clear the submitting guard
  // after render (refs mutated here, not during render).
  useEffect(() => {
    questionStartedAtRef.current = Date.now();
    submittingRef.current = false;
  }, [questionId]);

  const handleOptionClick = useCallback(
    (label: string) => {
      if (hasAnswered) return;
      if (submittingRef.current) return;

      submittingRef.current = true;

      setSelectedAnswer(label);
      const correct = label === correctLabel;
      onAnswer(correct);
      setShowResult(true);
      setHasAnswered(true);

      const responseTimeMs = questionStartedAtRef.current
        ? Date.now() - questionStartedAtRef.current
        : undefined;

      const attemptPayload = buildMcqAttemptPayload(shuffledOptions, label);

      onSubmit({ label, correct, responseTimeMs, attemptPayload });
    },
    [hasAnswered, correctLabel, onAnswer, shuffledOptions, onSubmit]
  );

  const handleReset = useCallback(() => {
    questionStartedAtRef.current = Date.now();
    setSelectedAnswer(null);
    setShowResult(false);
    setHasAnswered(false);
    submittingRef.current = false;
    resetConfidence();
    onReset?.();
  }, [resetConfidence, onReset]);

  const isCorrect = selectedAnswer === correctLabel;

  return {
    selectedAnswer,
    showResult,
    hasAnswered,
    isCorrect,
    handleOptionClick,
    handleReset,
    gradeConfidence,
    confidenceSelected,
    confidenceStatus,
  };
}
