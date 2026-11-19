/** Public build has no private learner preparation requests. */
export interface PresentationPrepReoffer { schema: 1; id: string; rotation: string; week: number; startsAt: string; expiresAt: string; questionIds: string[]; cardIds?: string[]; }
export function activePresentationPrepReoffer(_raw: unknown, _rotation: string, _now = new Date()): PresentationPrepReoffer | null { return null; }
export function batchExposureMayBeReoffered(_event: unknown, _policy: PresentationPrepReoffer | null | undefined, _now = new Date()): boolean { return false; }
export function presentationPrepCardIsEligible(_progress: unknown, _policy: PresentationPrepReoffer, _now: Date): boolean { return false; }
export function presentationPrepCardReviewCutoff(_policy: PresentationPrepReoffer, _now: Date): Date { return new Date(0); }
