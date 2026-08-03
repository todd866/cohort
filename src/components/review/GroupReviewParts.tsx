'use client';

import { memo } from 'react';
import Image from 'next/image';
import { QuestionGroupStep, StepOption, TeachingExplanation } from '@/lib/question-groups/types';
import { containsMath } from '@/lib/math/contains-math';
import { GlossaryText } from '@/components/content/GlossaryText';
import { MathHtml } from '@/components/review/MathHtml';
import { ABGContextPanel } from '@/components/review/ABGContextPanel';

/**
 * Presentational pieces of the group-review flow. All memoised, all
 * stateless — they render the slices the orchestrator wires together from
 * `useGroupReview`. Behaviour and markup are a 1:1 extraction from the old
 * monolithic GroupReview.tsx.
 */

/**
 * Render text with math support.
 * Note: dangerouslySetInnerHTML is safe here - KaTeX only produces mathematical
 * HTML and content is from our controlled card/question bank, not user input.
 */
const MathText = memo(function MathText({ text }: { text: string }) {
  if (containsMath(text)) {
    return <MathHtml text={text} />;
  }
  return <GlossaryText text={text} />;
});

/**
 * Render a structured teaching explanation with sections.
 */
const TeachingExplanationView = memo(function TeachingExplanationView({ teaching }: { teaching: TeachingExplanation }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="font-semibold text-[var(--md-on-surface)] mb-1">How to do this:</div>
        <div className="text-[var(--md-on-surface-variant)] whitespace-pre-line"><GlossaryText text={teaching.method} /></div>
      </div>
      <div>
        <div className="font-semibold text-[var(--md-on-surface)] mb-1">In this image:</div>
        <div className="text-[var(--md-on-surface-variant)] whitespace-pre-line"><GlossaryText text={teaching.application} /></div>
      </div>
      <div>
        <span className="font-semibold text-[var(--md-on-surface)]">Answer: </span>
        <span className="text-[var(--md-on-surface-variant)]"><GlossaryText text={teaching.answer} /></span>
      </div>
      {teaching.clinical && (
        <div className="pt-2 border-t border-[var(--md-outline-variant)]">
          <span className="font-semibold text-[var(--md-tertiary)]">Clinical pearl: </span>
          <span className="text-[var(--md-on-surface-variant)]"><GlossaryText text={teaching.clinical} /></span>
        </div>
      )}
    </div>
  );
});

/** Compact progress header (step counter, copyable groupId, skip) + progress bar. */
export const GroupProgressHeader = memo(function GroupProgressHeader({
  currentStepIndex,
  totalSteps,
  phaseName,
  groupId,
  onSkip,
}: {
  currentStepIndex: number;
  totalSteps: number;
  phaseName?: string;
  groupId?: string;
  onSkip: () => void;
}) {
  return (
    <>
      {/* Progress bar - compact */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-[var(--md-outline-variant)]">
        <div className="text-xs text-[var(--md-on-surface-variant)] flex items-center gap-2">
          <span>{currentStepIndex + 1}/{totalSteps} · {phaseName}</span>
          {groupId && (
            <button
              onClick={() => navigator.clipboard.writeText(groupId)}
              className="opacity-40 hover:opacity-100 font-mono text-[10px] transition-opacity"
              title={`Click to copy: ${groupId}`}
            >
              [{groupId.slice(-8)}]
            </button>
          )}
        </div>
        <button
          onClick={onSkip}
          className="text-xs text-[var(--md-on-surface-variant)] hover:text-[var(--md-error)] transition-colors"
          title="Skip this group (S)"
          aria-label="Skip this group"
        >
          Skip <span className="opacity-50">S</span>
        </button>
      </div>

      {/* Progress indicator */}
      <div className="h-1 bg-[var(--md-surface-container-highest)]">
        <div
          className="h-full bg-[var(--md-primary)] transition-all duration-300"
          style={{ width: `${((currentStepIndex + 1) / totalSteps) * 100}%` }}
        />
      </div>
    </>
  );
});

/** Full-screen image overlay (tap to expand / close). */
export const GroupImageOverlay = memo(function GroupImageOverlay({
  contextImageUrl,
  groupType,
  hasStepSpecificImage,
  currentStep,
  currentStepIndex,
  totalSteps,
  onClose,
}: {
  contextImageUrl: string;
  groupType: string;
  hasStepSpecificImage: boolean;
  currentStep: QuestionGroupStep;
  currentStepIndex: number;
  totalSteps: number;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--md-surface)] flex flex-col cursor-pointer"
      onClick={onClose}
    >
      {/* Image area - takes most of screen */}
      <div className="flex-1 relative min-h-0">
        <Image
          src={contextImageUrl}
          alt={`${groupType.toUpperCase()} image`}
          fill
          className="object-contain p-2"
          sizes="100vw"
          priority
          unoptimized
        />
      </div>
      <div className="absolute top-4 right-4 flex items-center gap-2">
        {hasStepSpecificImage && (
          <span className="text-sm text-[var(--md-on-surface)]/70 bg-[var(--md-surface)]/90 px-2 py-1 rounded shadow-sm font-medium">
            Full 12-lead
          </span>
        )}
        <span className="text-sm text-[var(--md-on-surface)]/70 bg-[var(--md-surface)]/90 px-2 py-1 rounded shadow-sm">
          tap to close
        </span>
      </div>
      {/* Question panel at bottom */}
      <div
        className="shrink-0 bg-[var(--md-surface-container-highest)] text-[var(--md-on-surface)] p-3 max-h-[30vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs text-[var(--md-on-surface-variant)] mb-1">
          {currentStepIndex + 1}/{totalSteps} · {currentStep.phaseName}
        </div>
        <div className="text-sm">
          <MathText text={currentStep.type === 'mcq' ? (currentStep.stem || '') : (currentStep.front || '')} />
        </div>
      </div>
    </div>
  );
});

/** Left/top panel: context image (tap to expand) + context text (or structured ABG panel). */
export const GroupContextPanel = memo(function GroupContextPanel({
  groupType,
  stepImageUrl,
  hasStepSpecificImage,
  currentStep,
  contextText,
  imageError,
  onToggleImageExpand,
  onImageError,
}: {
  groupType: string;
  stepImageUrl: string | null;
  hasStepSpecificImage: boolean;
  currentStep: QuestionGroupStep;
  contextText?: string | null;
  imageError: boolean;
  onToggleImageExpand: () => void;
  onImageError: () => void;
}) {
  return (
    <div className={`${groupType === 'ecg' ? '' : 'md:w-1/2 md:flex md:flex-col md:border-r md:border-[var(--md-outline-variant)]'}`}>
      {/* Context image - shows step-specific cropped view for ECG, tap to expand full */}
      {stepImageUrl && !imageError && (
        <div
          className={`bg-[var(--md-surface)] cursor-pointer flex items-center justify-center relative ${
            groupType === 'ecg'
              ? ''
              : 'shrink-0 md:shrink md:flex-1 md:min-h-0'
          }`}
          onClick={onToggleImageExpand}
        >
          <Image
            src={stepImageUrl}
            alt={`${groupType.toUpperCase()} image`}
            width={groupType === 'cxr' ? 800 : 1200}
            height={groupType === 'cxr' ? 1000 : (hasStepSpecificImage ? 400 : 600)}
            className={`h-auto object-contain ${
              groupType === 'ecg'
                ? 'w-full'
                : groupType === 'cxr'
                  ? 'max-h-[35vh] md:max-h-[70vh] w-auto max-w-full'
                  : hasStepSpecificImage
                    ? 'w-full max-h-[40vh] md:max-h-[60vh]'
                    : 'w-full max-h-[35vh] md:max-h-[60vh]'
            }`}
            priority
            onError={onImageError}
            unoptimized
          />
          {/* View indicator and tap hint */}
          <div className="absolute bottom-2 right-2 flex items-center gap-2">
            {hasStepSpecificImage && currentStep.view && (
              <span className="text-xs text-[var(--md-on-surface)]/70 bg-[var(--md-surface)]/90 px-2 py-1 rounded shadow-sm font-medium">
                {currentStep.view}
              </span>
            )}
            <span className="text-xs text-[var(--md-on-surface)]/60 bg-[var(--md-surface)]/80 px-2 py-1 rounded shadow-sm">
              {hasStepSpecificImage ? 'tap for full 12-lead' : 'tap to expand'}
            </span>
          </div>
        </div>
      )}

      {/* Context text - compact, or structured ABG panel */}
      {contextText && (
        groupType === 'abg' ? (
          <ABGContextPanel contextText={contextText} />
        ) : (
          <div className="px-3 py-1.5 bg-[var(--md-surface-container-high)] text-xs text-[var(--md-on-surface-variant)] border-b border-[var(--md-outline-variant)] md:border-b-0">
            <GlossaryText text={contextText} />
          </div>
        )
      )}
    </div>
  );
});

/** Right/bottom panel: the current step's body (card front/back or MCQ stem/options/explanation). */
export const GroupStepContent = memo(function GroupStepContent({
  groupType,
  currentStep,
  revealed,
  mcqAnswered,
  selectedOption,
  displayOptions,
}: {
  groupType: string;
  currentStep: QuestionGroupStep;
  revealed: boolean;
  mcqAnswered: boolean;
  selectedOption: string | null;
  displayOptions: StepOption[];
}) {
  return (
    // pb-48 provides space for fixed footer buttons
    <div className={`p-3 pb-48 ${groupType === 'ecg' ? '' : 'md:w-1/2 md:overflow-y-auto'}`}>
      {/* CARD type step */}
      {currentStep.type === 'card' && (
        <>
          <div className="text-[var(--md-on-surface)] text-sm mb-3">
            <MathText text={currentStep.front || ''} />
          </div>

          {/* Answer shown after reveal - buttons are in fixed footer */}
          {revealed && (
            <div className="p-2 rounded-lg bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] text-sm">
              <MathText text={currentStep.back || ''} />
            </div>
          )}
        </>
      )}

      {/* MCQ type step */}
      {currentStep.type === 'mcq' && currentStep.options && (
        <>
          <div className="text-[var(--md-on-surface)] text-sm mb-2 whitespace-pre-line">
            <MathText text={currentStep.stem || ''} />
          </div>

          {/* Options shown inline only AFTER answering (to show correct/incorrect feedback) */}
          {mcqAnswered && (
            <div className="space-y-2 mb-3">
              {displayOptions.map((option, index) => {
                const numLabel = index + 1;
                const isSelected = selectedOption === option.label;
                const isCorrect = option.isCorrect;
                const isWrong = isSelected && !option.isCorrect;

                let optionClass = 'border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]';
                let numberClass = 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]';
                if (isCorrect) {
                  optionClass = 'border-[var(--md-success)] bg-[var(--md-success-container)]';
                  numberClass = 'bg-[var(--md-success)] text-white';
                } else if (isWrong) {
                  optionClass = 'border-[var(--md-error)] bg-[var(--md-error-container)]';
                  numberClass = 'bg-[var(--md-error)] text-white';
                }

                return (
                  <div
                    key={option.label}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border-2 text-sm flex items-start gap-2.5 ${optionClass}`}
                  >
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold flex-shrink-0 ${numberClass}`}>
                      {numLabel}
                    </span>
                    <span className="flex-1 pt-0.5"><MathText text={option.text} /></span>
                    {isCorrect && <span className="text-[var(--md-success)] text-lg flex-shrink-0">✓</span>}
                    {isWrong && <span className="text-[var(--md-error)] text-lg flex-shrink-0">✗</span>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Explanation after answering */}
          {mcqAnswered && (currentStep.teaching || currentStep.context) && (
            <div className="p-3 rounded-lg bg-[var(--md-surface-container-high)] text-sm">
              {currentStep.teaching ? (
                <TeachingExplanationView teaching={currentStep.teaching} />
              ) : (
                <div className="text-[var(--md-on-surface-variant)]">
                  <MathText text={currentStep.context || ''} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});

/** Fixed footer: MCQ options to choose from (before answering). */
export const GroupOptionsFooter = memo(function GroupOptionsFooter({
  displayOptions,
  onSelectOption,
}: {
  displayOptions: StepOption[];
  onSelectOption: (label: string) => void;
}) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-[var(--md-surface)] border-t border-[var(--md-outline-variant)] p-3 max-h-[55vh] overflow-y-auto">
      <div className="max-w-2xl mx-auto space-y-2">
        {displayOptions.map((option, index) => {
          const numLabel = index + 1;
          return (
            <button
              key={option.label}
              onClick={() => onSelectOption(option.label)}
              className="w-full text-left px-3 py-2.5 rounded-xl border-2 border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] hover:border-[var(--md-primary)] hover:shadow-sm active:scale-[0.99] cursor-pointer transition-all text-sm flex items-start gap-2.5"
            >
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold flex-shrink-0 bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]">
                {numLabel}
              </span>
              <span className="flex-1 pt-0.5"><MathText text={option.text} /></span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
