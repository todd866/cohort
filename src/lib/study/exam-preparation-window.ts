/** Public export has no private cohort activation. */
export type ExamPreparationWindow = 'day-before' | 'exam-day';
export function examPreparationRolloutEnabled(_input: unknown): boolean { return false; }
export function resolveExamPreparationWindow(_input: unknown): ExamPreparationWindow | null { return null; }
