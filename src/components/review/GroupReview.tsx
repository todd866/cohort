'use client';

import { useRef } from 'react';
import { QuestionGroupStep, StepResult } from '@/lib/question-groups/types';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import { getResetKey } from './groupReviewLogic';
import { useGroupReview } from './hooks/useGroupReview';
import { useGroupReviewKeyboard } from './hooks/useGroupReviewKeyboard';
import { useAutoScrollIntoView } from './hooks/useAutoScrollIntoView';
import {
  GroupProgressHeader,
  GroupImageOverlay,
  GroupContextPanel,
  GroupStepContent,
  GroupOptionsFooter,
} from './GroupReviewParts';

// Re-exported for backward compatibility; lives in groupReviewLogic now.
export { getStepDisplayOptions } from './groupReviewLogic';

interface GroupReviewProps {
  groupId?: string; // For debugging/reference
  groupType: string;
  contextImageUrl?: string | null;
  contextText?: string | null;
  steps: QuestionGroupStep[];
  maxQuestionsPerPhase?: number; // Default: 1-2 random questions per phase
  onComplete: (results: StepResult[], skipped: boolean) => void;
  onSkip: () => void;
}

export function GroupReview(props: GroupReviewProps) {
  // Remount on a new step set so all per-group state (index, attempt seed,
  // results) resets cleanly. See getResetKey.
  return <GroupReviewInner key={getResetKey(props.steps)} {...props} />;
}

function GroupReviewInner({
  groupId,
  groupType,
  contextImageUrl,
  contextText,
  steps,
  maxQuestionsPerPhase = 2,
  onComplete,
  onSkip,
}: GroupReviewProps) {
  const {
    currentStep,
    currentStepIndex,
    totalSteps,
    displayOptions,
    stepImageUrl,
    hasStepSpecificImage,
    revealed,
    selectedOption,
    mcqAnswered,
    mcqShowRating,
    imageError,
    imageExpanded,
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
  } = useGroupReview({ groupType, contextImageUrl, steps, maxQuestionsPerPhase, onComplete, onSkip });

  // Rating button refs — bridged to the auto-scroll hook so the buttons come
  // into view once the answer/reveal happens.
  const cardRatingRef = useRef<HTMLDivElement>(null);
  const mcqRatingRef = useRef<HTMLDivElement>(null);
  useAutoScrollIntoView(cardRatingRef, revealed);
  useAutoScrollIntoView(mcqRatingRef, mcqShowRating);

  useGroupReviewKeyboard({
    currentStep,
    groupType,
    revealed,
    mcqAnswered,
    mcqShowRating,
    displayOptions,
    handleReveal,
    handleCardGrade,
    advanceWithoutRating,
    handleSelectOption,
    handleMcqSkip,
    handleMcqGrade,
    handleMcqContinue,
    toggleImageExpand,
    handleSkipGroup,
  });

  // Defensive guard: an empty step set has no current step to render. Should not
  // happen (groups always have steps), but render nothing rather than crash.
  if (!currentStep) return null;

  // Main review UI
  // Mobile: no nested scroll - use native page scroll
  // Desktop: contained with max-height
  return (
    <div className="bg-[var(--md-surface-container)] rounded-xl overflow-hidden md:max-h-[90vh] md:flex md:flex-col">
      {/* Full-screen image overlay (tap to expand) */}
      {imageExpanded && contextImageUrl && (
        <GroupImageOverlay
          contextImageUrl={contextImageUrl}
          groupType={groupType}
          hasStepSpecificImage={hasStepSpecificImage}
          currentStep={currentStep}
          currentStepIndex={currentStepIndex}
          totalSteps={totalSteps}
          onClose={toggleImageExpand}
        />
      )}

      <GroupProgressHeader
        currentStepIndex={currentStepIndex}
        totalSteps={totalSteps}
        phaseName={currentStep.phaseName}
        groupId={groupId}
        onSkip={handleSkipGroup}
      />

      {/* Main content: ECGs always stacked (need full width), others side-by-side on desktop */}
      <div className={`${groupType === 'ecg' ? '' : 'md:flex md:flex-1 md:min-h-0'}`}>
        <GroupContextPanel
          groupType={groupType}
          stepImageUrl={stepImageUrl}
          hasStepSpecificImage={hasStepSpecificImage}
          currentStep={currentStep}
          contextText={contextText}
          imageError={imageError}
          onToggleImageExpand={toggleImageExpand}
          onImageError={handleImageError}
        />
        <GroupStepContent
          groupType={groupType}
          currentStep={currentStep}
          revealed={revealed}
          mcqAnswered={mcqAnswered}
          selectedOption={selectedOption}
          displayOptions={displayOptions}
        />
      </div>

      {/* FIXED FOOTER: MCQ Options (before answering) */}
      {currentStep.type === 'mcq' && currentStep.options && !mcqAnswered && (
        <GroupOptionsFooter displayOptions={displayOptions} onSelectOption={handleSelectOption} />
      )}

      {/* FIXED FOOTER: MCQ Rating (after answering) */}
      {currentStep.type === 'mcq' && mcqShowRating && (
        <ConfidenceButtons mode="footer" onSelect={handleMcqGrade} wrapperRef={mcqRatingRef} />
      )}

      {/* FIXED FOOTER: Card reveal button */}
      {currentStep.type === 'card' && !revealed && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-[var(--md-surface)] border-t border-[var(--md-outline-variant)] p-3">
          <div className="max-w-2xl mx-auto">
            <button
              onClick={handleReveal}
              className="w-full p-3 rounded-lg border-2 border-dashed border-[var(--md-outline-variant)] text-[var(--md-on-surface-variant)] hover:border-[var(--md-primary)] text-sm"
            >
              tap or [space / enter] to reveal
            </button>
          </div>
        </div>
      )}

      {/* FIXED FOOTER: Card rating (after reveal) */}
      {currentStep.type === 'card' && revealed && (
        <ConfidenceButtons mode="footer" onSelect={handleCardGrade} wrapperRef={cardRatingRef} />
      )}
    </div>
  );
}
