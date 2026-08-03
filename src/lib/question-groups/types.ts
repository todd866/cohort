/**
 * Linked Question Groups - TypeScript Types
 *
 * Multi-step review items with shared context (ECG interpretation, ABG, CXR, etc.)
 * See docs/plans/2026-01-19-linked-question-groups-design.md
 */

// Step types: either a card (reveal + self-rate) or MCQ (select answer)
export type StepType = 'card' | 'mcq';

// MCQ option
export interface StepOption {
  label: string; // 'A', 'B', 'C', 'D'
  text: string;
  isCorrect: boolean;
}

// Structured teaching explanation
export interface TeachingExplanation {
  method: string;      // How to do this in general (transferable skill)
  application: string; // What to look for in THIS specific image
  answer: string;      // The answer with brief rationale
  clinical?: string;   // Clinical pearl - why this matters (optional)
}

// ECG view presets - maps to cropped images
export type ECGView = 'rhythm' | 'inferior' | 'lateral' | 'anterior' | 'septal' | 'precordial' | 'limb';

// Individual step within a question group
export interface QuestionGroupStep {
  id: string;
  phase: string; // "initial" | "waves" | "intervals"
  phaseName: string; // "Initial Features"
  stepNumber: number; // 1-12 for ECG

  // Content type
  type: StepType;

  // ECG view fields (for showing cropped portions of 12-lead)
  view?: ECGView; // Preset view: 'rhythm', 'inferior', 'anterior', etc.
  leads?: string[]; // Custom lead combination: ['V1', 'V2'] (overrides view)

  // Card fields (if type === 'card')
  front?: string; // "Rate is ___"
  back?: string; // "150 bpm - sinus tachycardia"

  // MCQ fields (if type === 'mcq')
  stem?: string; // "What is the rhythm?"
  options?: StepOption[];
  context?: string; // Legacy simple explanation
  teaching?: TeachingExplanation; // Structured teaching explanation (preferred)

  // Option rotation fields (for expanded MCQs)
  combinations?: number[][]; // [[0,1,2,3], [0,1,4,5]] - indices into options array
  correctVariants?: string[]; // Alternative phrasings of correct answer
}

// Result for a single step in an attempt
export interface StepResult {
  stepId: string;
  stepIndex?: number; // Original step index in the group attempt
  correct: boolean; // For MCQs
  quality?: number; // For cards (0-5 self-rating)
  responseTimeMs: number;
  selectedOption?: string; // For MCQs: 'A', 'B', etc.
}

// ECG Rule of Fours phases
export const ECG_PHASES = {
  initial: {
    name: 'Initial Features',
    steps: ['rate', 'rhythm', 'axis', 'context'],
  },
  waves: {
    name: 'Waves',
    steps: ['p-wave', 'qrs', 't-wave', 'u-wave'],
  },
  intervals: {
    name: 'Intervals',
    steps: ['pr', 'qrs-width', 'st', 'qt'],
  },
} as const;

// Group types supported
export type GroupType = 'ecg' | 'abg' | 'cxr' | 'clinical';

/**
 * Shared case interface for all question group types (ECG, CXR, ABG, etc.)
 *
 * Each case defines a clinical scenario with multi-step questions.
 * contextImageUrl is optional (ABG cases are text-only).
 */
export interface QuestionGroupCase {
  slug: string;
  contextImageUrl?: string;
  contextText: string;
  diagnosisSummary: string;
  difficulty: 'easy' | 'medium' | 'hard';
  topics: string[];
  rotation?: string;
  week?: number;
  steps: QuestionGroupStep[];
}

// Helper to get phase info from step number (1-indexed)
export function getECGPhase(stepNumber: number): { phase: string; phaseName: string } {
  if (stepNumber <= 4) {
    return { phase: 'initial', phaseName: 'Initial Features' };
  } else if (stepNumber <= 8) {
    return { phase: 'waves', phaseName: 'Waves' };
  } else {
    return { phase: 'intervals', phaseName: 'Intervals' };
  }
}

// Create a card-type step
export function createCardStep(params: {
  id: string;
  stepNumber: number;
  front: string;
  back: string;
  phase?: string;
  phaseName?: string;
}): QuestionGroupStep {
  const phaseInfo = params.phase
    ? { phase: params.phase, phaseName: params.phaseName || params.phase }
    : getECGPhase(params.stepNumber);

  return {
    id: params.id,
    stepNumber: params.stepNumber,
    phase: phaseInfo.phase,
    phaseName: phaseInfo.phaseName,
    type: 'card',
    front: params.front,
    back: params.back,
  };
}

/**
 * MCQ WRITING CHECKLIST - STOP AND CHECK BEFORE SUBMITTING
 *
 * [ ] Correct answer is NOT always option A
 * [ ] Correct answer is NOT the longest option
 * [ ] Correct answer is NOT the most detailed/specific option
 * [ ] All options have similar length and structure
 * [ ] No "all of the above" or "none of the above"
 * [ ] Distractors are plausible, not obviously wrong
 * [ ] No double negatives in stem
 * [ ] Stem makes sense without reading options
 *
 * COMMON MISTAKES:
 * - "Activate cath lab / primary PCI" vs "Thrombolytics" (correct is longer)
 * - "ST depression (reciprocal)" vs "Normal" (correct has parenthetical)
 * - Correct answer always first in the list
 */

// Create an MCQ-type step
export function createMCQStep(params: {
  id: string;
  stepNumber: number;
  stem: string;
  options: StepOption[];
  context?: string;
  teaching?: TeachingExplanation;
  phase?: string;
  phaseName?: string;
  view?: ECGView;
  leads?: string[];
}): QuestionGroupStep {
  const phaseInfo = params.phase
    ? { phase: params.phase, phaseName: params.phaseName || params.phase }
    : getECGPhase(params.stepNumber);

  return {
    id: params.id,
    stepNumber: params.stepNumber,
    phase: phaseInfo.phase,
    phaseName: phaseInfo.phaseName,
    type: 'mcq',
    stem: params.stem,
    options: params.options,
    context: params.context,
    teaching: params.teaching,
    view: params.view,
    leads: params.leads,
  };
}

/**
 * Get the image URL for a step, considering view/leads overrides.
 *
 * For ECG steps with view or leads specified, returns the cropped image URL.
 * Otherwise returns the full context image URL.
 *
 * @param contextImageUrl Base image URL (e.g., 'https://pub-c376f836c4cc4ecfae4c8b545e006a47.r2.dev/ptbxl/ptbxl_00001.png')
 * @param step The question group step
 * @returns Image URL to display for this step
 */
export function getStepImageUrl(
  contextImageUrl: string | null | undefined,
  step: QuestionGroupStep
): string | null {
  if (!contextImageUrl) return null;

  // If step has view or leads, use cropped image
  if (step.view) {
    // Replace .png with _view.png
    return contextImageUrl.replace(/\.png$/, `_${step.view}.png`);
  }

  if (step.leads && step.leads.length > 0) {
    // Custom leads - would need to be pre-rendered with specific naming
    // For now, fall back to full image
    // TODO: Support custom lead combinations
    return contextImageUrl;
  }

  // Default: use full context image
  return contextImageUrl;
}
