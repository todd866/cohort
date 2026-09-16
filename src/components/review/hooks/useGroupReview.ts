import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { QuestionGroupStep, StepResult, getStepImageUrl } from '@/lib/question-groups/types';
import { getStepDisplayOptions, sampleStepsForType } from '../groupReviewLogic';

interface UseGroupReviewOptions {
  groupType: string;
  contextImageUrl?: string | null;
  steps: QuestionGroupStep[];
  maxQuestionsPerPhase?: number;
  onComplete: (results: StepResult[], skipped: boolean) => void;
  onSkip: () => void;
}

/**
 * State machine for the multi-step group review: step sampling, per-step
 * card/MCQ interaction state, result accumulation, and advancement.
 *
 * DOM-free by design — the orchestrator owns the rating refs and feeds the
 * `revealed` / `mcqShowRating` flags into `useAutoScrollIntoView`. This hook is
 * meant to be mounted under a `key` that changes per group, so its `useState`
 * resets give each group a clean slate (and a fresh `attemptSeed`).
 */
export function useGroupReview({
  groupType,
  contextImageUrl,
  steps,
  maxQuestionsPerPhase = 2,
  onComplete,
  onSkip,
}: UseGroupReviewOptions) {
  const sampledSteps = useMemo(
    () => sampleStepsForType(steps, groupType, maxQuestionsPerPhase),
    [steps, maxQuestionsPerPhase, groupType]
  );

  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  // Vary combination / correct-variant / option order per viewing. The display
  // call site previously hardcoded 0, pinning every attempt to combination 0,
  // correct-variant 0, and one fixed shuffle order — so a re-served group was
  // identical each time and became position-memorisable. Random per mount =
  // per serve; stable within a viewing via the lazy initialiser.
  const [attemptSeed] = useState(() => Math.floor(Math.random() * 1_000_000));
  const [stepResults, setStepResults] = useState<StepResult[]>([]);
  const [imageError, setImageError] = useState(false);
  const [imageExpanded, setImageExpanded] = useState(false);

  // Card state
  const [revealed, setRevealed] = useState(false);

  // MCQ state
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [mcqAnswered, setMcqAnswered] = useState(false);
  const [mcqShowRating, setMcqShowRating] = useState(false);
  const stepStartTimeRef = useRef<number>(0);

  useEffect(() => {
    stepStartTimeRef.current = Date.now();
  }, []);

  const currentStep = sampledSteps[currentStepIndex];
  const totalSteps = sampledSteps.length;
  const isLastStep = currentStepIndex === totalSteps - 1;

  // For ECG steps with view/leads, use cropped image; otherwise use full context image.
  // currentStep can be undefined for an empty step set — derive defensively so the
  // orchestrator can render nothing rather than crash.
  const stepImageUrl = useMemo(
    () => (currentStep ? getStepImageUrl(contextImageUrl, currentStep) : null),
    [contextImageUrl, currentStep]
  );

  // Check if this step has a different image than the context (for showing "view full" button)
  const hasStepSpecificImage = Boolean(contextImageUrl && stepImageUrl !== contextImageUrl);

  // Memoize display options for current step (applies combinations + shuffle)
  const displayOptions = useMemo(
    () => (currentStep ? getStepDisplayOptions(currentStep, attemptSeed) : []),
    [currentStep, attemptSeed]
  );

  const goToNextStep = useCallback(() => {
    setCurrentStepIndex(prev => prev + 1);
    setRevealed(false);
    setSelectedOption(null);
    setMcqAnswered(false);
    setMcqShowRating(false);
    stepStartTimeRef.current = Date.now();
  }, []);

  const recordAndAdvance = useCallback((correct: boolean, quality?: number, selectedOpt?: string) => {
    const responseTimeMs = Date.now() - stepStartTimeRef.current;
    const result: StepResult = {
      stepId: currentStep.id,
      stepIndex: currentStepIndex,
      correct,
      quality,
      responseTimeMs,
      selectedOption: selectedOpt,
    };

    const newResults = [...stepResults, result];
    setStepResults(newResults);

    if (isLastStep) {
      // Complete with the new results (not stale closure)
      onComplete(newResults, false);
    } else {
      goToNextStep();
    }
  }, [currentStep, currentStepIndex, stepResults, isLastStep, onComplete, goToNextStep]);

  const advanceWithoutRating = useCallback(() => {
    if (isLastStep) {
      onComplete(stepResults, false);
    } else {
      goToNextStep();
    }
  }, [isLastStep, onComplete, stepResults, goToNextStep]);

  // Card handlers
  const handleReveal = useCallback(() => {
    setRevealed(true);
  }, []);

  const handleCardGrade = useCallback((quality: number) => {
    const correct = quality >= 3;
    recordAndAdvance(correct, quality);
  }, [recordAndAdvance]);

  // MCQ handlers - show answer then rating buttons after brief delay
  // Delay prevents keyboard repeat from immediately triggering rating
  const handleSelectOption = useCallback((label: string) => {
    if (mcqAnswered) return;
    setSelectedOption(label);
    setMcqAnswered(true);
    // Small delay to prevent key repeat from auto-rating
    setTimeout(() => {
      setMcqShowRating(true);
    }, 300);
  }, [mcqAnswered]);

  const handleMcqSkip = useCallback(() => {
    if (mcqAnswered) return;
    setSelectedOption(null);
    setMcqAnswered(true);
    setTimeout(() => {
      setMcqShowRating(true);
    }, 300);
  }, [mcqAnswered]);

  const handleMcqGrade = useCallback((quality: number) => {
    const option = currentStep.options?.find(o => o.label === selectedOption);
    const correct = option?.isCorrect ?? false;
    recordAndAdvance(correct, quality, selectedOption ?? undefined);
  }, [currentStep, selectedOption, recordAndAdvance]);

  // MCQ: continue past the rating step without recording confidence
  const handleMcqContinue = useCallback(() => {
    const option = currentStep.options?.find(o => o.label === selectedOption);
    const correct = option?.isCorrect ?? false;
    recordAndAdvance(correct, undefined, selectedOption ?? undefined);
  }, [currentStep, selectedOption, recordAndAdvance]);

  // Skip entire group
  const handleSkipGroup = useCallback(() => {
    onSkip();
  }, [onSkip]);

  // Toggle image expansion
  const toggleImageExpand = useCallback(() => {
    setImageExpanded(prev => !prev);
  }, []);

  const handleImageError = useCallback(() => {
    setImageError(true);
  }, []);

  return {
    // derived view state
    currentStep,
    currentStepIndex,
    totalSteps,
    displayOptions,
    stepImageUrl,
    hasStepSpecificImage,
    // ui flags
    revealed,
    selectedOption,
    mcqAnswered,
    mcqShowRating,
    imageError,
    imageExpanded,
    // handlers
    handleReveal,
    handleCardGrade,
    handleSelectOption,
    handleMcqSkip,
    handleMcqGrade,
    handleMcqContinue,
    advanceWithoutRating,
    handleSkipGroup,
    toggleImageExpand,
    handleImageError,
  };
}
