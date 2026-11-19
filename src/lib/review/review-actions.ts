/**
 * The review screen's actions, for anything other than a key or a tap that
 * needs to perform them (a voice session, say). The review component registers
 * the same closures its keyboard shortcuts call, so an action taken through
 * here follows exactly the path a key press does; nothing is re-implemented.
 *
 * One review screen is on a page at a time, so this is a single slot.
 */

import type { NativeExamState } from '@/lib/tutor/native-review-protocol';

/** Stable DOM marker on the review feedback dialog; voice tools ignore only this modal. */
export const REVIEW_FEEDBACK_DIALOG_MARKER = 'data-md3-review-feedback';

export type ReviewFeedbackSubmissionStatus = 'idle' | 'submitting' | 'queued' | 'delivered' | 'error';

export interface ReviewFeedbackState {
  open: boolean;
  draft: string;
  hasImage: boolean;
  /** Matches the existing textarea's disabled condition. */
  editable?: boolean;
  status: ReviewFeedbackSubmissionStatus;
  submissionGeneration: number;
  error?: string;
}

export interface ReviewActionState {
  exam?: NativeExamState;
  kind: 'card' | 'question' | null;
  /** The item's id, to notice when the screen has moved on. */
  itemId: string | null;
  /** Distinguishes another delivery or a rewind of the same content id. */
  presentationId?: string;
  /** The original flag form is open; other voice mutations must wait. */
  flagOpen?: boolean;
  /** Visible report form state for voice snapshots; absent when review cannot act. */
  feedback?: ReviewFeedbackState;
  /** The visible empty state is final, rather than a fetch or modal transition. */
  completed?: boolean;
  /** The answer is showing: a card revealed, a question answered. */
  revealed: boolean;
  /** How many options a question offers. */
  optionCount?: number;
  remaining?: number;
}

export interface ReviewActions {
  state: () => ReviewActionState;
  /**
   * The item in words: what it asks, and its answer once that is showing.
   * `expected` (a card's answers, one per blank) and `options` (a question's
   * option texts, in order) are there before the answer shows, to recognise an
   * answer given some other way than a key; they are never to be shown or said.
   */
  describe: () => {
    prompt: string;
    /** Question stem without its separately labelled displayed options. */
    stem?: string;
    answer: string | null;
    outcome?: 'correct' | 'incorrect';
    expected?: string[];
    options?: string[];
    /** Action key and the badge actually rendered; they can be a letter and a number. */
    labelledOptions?: Array<{ label: string; text: string; displayLabel?: string }>;
    /** Only populated after reveal. */
    explanation?: string;
  };
  /**
   * Everything on screen about the item, for a voice to talk about it
   * (`itemBackground`): only what the learner can see, so the answer and its
   * explanations appear once they are showing.
   */
  background?: () => string;
  /**
   * The whole item for the voice, from the moment it shows: answer or keyed
   * option, why each option is right or wrong, the explanation and the
   * picture's caption (owner, 18 Nov 2026: "give the agent all the context in
   * one hit"). Private teacher notes: never put on the screen, and the voice
   * does not state or hint the answer unless the learner asks or has answered.
   */
  teacherNotes?: () => string;
  /** The item's figure as the learner can see it now (chat-figure rule), or null. */
  figure?: () => import('./chat-figure').ChatFigure | null;
  /** The next item in the review queue, for prefetching its voice brief; absent or null when unknown. */
  upcoming?: () => { type: 'card' | 'question'; id: string } | null;
  reveal: () => void;
  /** Confidence 1 to 4: Again, Hard, Good, Easy. */
  grade: (confidence: 1 | 2 | 3 | 4) => void;
  chooseOption: (label: string) => void;
  skip: () => void;
  next: () => void;
  /** Only present when the visible screen has a Previous control. */
  previous?: () => void;
  /** Opens the exam's existing confirmation; never submits the sitting. */
  requestSubmit?: () => void;
  flag: () => void;
  /** Replace the open report draft; does not submit. */
  draftFeedback?: (text: string) => void;
  /** Discard the open report draft and any unattached image. */
  cancelFeedback?: () => void;
  /** Submit the open report through the screen's normal durable queue. */
  submitFeedback?: () => void;
}

let registered: ReviewActions | null = null;

/** Called by the review screen on every render with its current handlers, and with null when it has none to offer. */
export function registerReviewActions(actions: ReviewActions | null): void {
  registered = actions;
}

/** The review screen's actions right now, or null when no item can be acted on. */
export function currentReviewActions(): ReviewActions | null {
  return registered;
}

/** How long after an action its write may still be attributed to the input that caused it. */
const INPUT_WINDOW_MS = 2_000;
let nonKeyInput: { origin: 'voice'; at: number } | null = null;

/** Say that the action about to be taken came from somewhere other than a key or a tap. */
export function markReviewInput(origin: 'voice'): void {
  nonKeyInput = { origin, at: Date.now() };
}

/** The input a review write should be recorded as coming from, when it was not a key or a tap. */
export function reviewInputOrigin(): 'voice' | undefined {
  if (!nonKeyInput || Date.now() - nonKeyInput.at > INPUT_WINDOW_MS) return undefined;
  return nonKeyInput.origin;
}

/**
 * Whether review is being driven by voice right now. The review screen reads
 * this to ask the scheduler for items that can be done by ear; whatever drives
 * review by voice sets it for as long as it does.
 */
let voiceReview = false;
const voiceReviewListeners = new Set<() => void>();

export function setVoiceReview(on: boolean): void {
  if (voiceReview === on) return;
  voiceReview = on;
  for (const listener of voiceReviewListeners) listener();
}

export function voiceReviewActive(): boolean {
  return voiceReview;
}

export function subscribeVoiceReview(listener: () => void): () => void {
  voiceReviewListeners.add(listener);
  return () => { voiceReviewListeners.delete(listener); };
}
