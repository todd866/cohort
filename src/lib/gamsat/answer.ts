/**
 * Grading and response-shaping for a GAMSAT answer.
 *
 * Pure and storage-free so it can be tested without a database or a request.
 * The route is the thin shell around it.
 *
 * CORRECTNESS IS DECIDED HERE, FROM THE STORED QUESTION — never from anything
 * the client sends. The client already holds the answer key (the corpus is
 * openly licensed and published, so there is nothing to hide), but a
 * client-asserted `isCorrect` would make the calibration data worthless the
 * moment anyone edited a request. The asset is only as good as its integrity.
 */

export interface StoredOption {
  label: string;
  text: string;
  isCorrect?: boolean;
}

export interface AnswerRequest {
  questionId: string;
  /** null means the learner skipped rather than answered. */
  selectedLabel: string | null;
  /** Option labels in the order actually shown, for shuffle-bias detection. */
  displayOrder?: string[];
  responseTimeMs?: number;
  confidence?: number;
}

export interface GradedAnswer {
  isCorrect: boolean;
  correctLabel: string;
  selectedLabel: string | null;
  correctDisplayPosition: number | null;
  selectedDisplayPosition: number | null;
  responseTimeMs: number | null;
  confidence: number | null;
}

export class AnswerValidationError extends Error {}

/** Reject anything that would silently corrupt the response record. */
export function parseAnswerRequest(body: unknown): AnswerRequest {
  if (typeof body !== 'object' || body === null) {
    throw new AnswerValidationError('body must be an object');
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.questionId !== 'string' || raw.questionId.trim() === '') {
    throw new AnswerValidationError('questionId is required');
  }
  const selectedLabel = raw.selectedLabel === null || raw.selectedLabel === undefined
    ? null
    : String(raw.selectedLabel);

  let displayOrder: string[] | undefined;
  if (Array.isArray(raw.displayOrder)) {
    displayOrder = raw.displayOrder.filter((v): v is string => typeof v === 'string');
  }

  // NO UPPER CAP, deliberately. /api/questions/respond carries the scar: a cap
  // there silently 400'd whole attempts, because a genuinely slow or
  // interrupted answer is not a broken client. Record what happened and let
  // analysis filter outliers — an unrecorded event cannot be recovered.
  // Negative and non-finite values are still refused: those are impossible,
  // not merely implausible.
  const responseTimeMs = typeof raw.responseTimeMs === 'number'
    && Number.isFinite(raw.responseTimeMs)
    && raw.responseTimeMs >= 0
    ? Math.round(raw.responseTimeMs)
    : undefined;

  const confidence = typeof raw.confidence === 'number'
    && Number.isInteger(raw.confidence)
    && raw.confidence >= 1
    && raw.confidence <= 4
    ? raw.confidence
    : undefined;

  return { questionId: raw.questionId, selectedLabel, displayOrder, responseTimeMs, confidence };
}

export function gradeAnswer(options: StoredOption[], request: AnswerRequest): GradedAnswer {
  const correct = options.find((option) => option.isCorrect === true);
  if (!correct) throw new AnswerValidationError('stored question has no correct option');

  const { selectedLabel, displayOrder } = request;
  if (selectedLabel !== null && !options.some((option) => option.label === selectedLabel)) {
    throw new AnswerValidationError(`selectedLabel ${selectedLabel} is not an option`);
  }

  const positionOf = (label: string | null): number | null => {
    if (label === null || !displayOrder || displayOrder.length === 0) return null;
    const index = displayOrder.indexOf(label);
    return index >= 0 ? index : null;
  };

  return {
    // A skip is recorded as incorrect but is NOT the same event as a wrong
    // answer; selectedLabel === null is what distinguishes them downstream.
    isCorrect: selectedLabel !== null && selectedLabel === correct.label,
    correctLabel: correct.label,
    selectedLabel,
    correctDisplayPosition: positionOf(correct.label),
    selectedDisplayPosition: positionOf(selectedLabel),
    responseTimeMs: request.responseTimeMs ?? null,
    confidence: request.confidence ?? null,
  };
}

/** Reasoning moves a question exercised, read back off its module nodes. */
export function movesFromModuleNodes(moduleNodes: string[]): string[] {
  return moduleNodes
    .filter((node) => node.startsWith('gamsat/move/'))
    .map((node) => node.slice('gamsat/move/'.length))
    .sort();
}
