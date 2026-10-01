/** Maximum length of a video excerpt that can autoplay in a flashcard. */
export const MAX_AUTOPLAY_CLIP_SECONDS = 15;
export const MIN_EXTENDED_CONTEXT_REASON_LENGTH = 20;

/**
 * A source window is deliberately short: the learner should recognise a
 * manoeuvre or structure, never watch a full operation. Endpoints are finite
 * source-timeline values and the interval must be strictly positive.
 */
export function isShortClipWindow(startSeconds: number, endSeconds: number): boolean {
  return Number.isFinite(startSeconds)
    && Number.isFinite(endSeconds)
    && startSeconds >= 0
    && endSeconds > startSeconds
    && endSeconds - startSeconds <= MAX_AUTOPLAY_CLIP_SECONDS;
}

/**
 * Measured MP4 duration allows 0.1s mux/container tolerance around the 15s
 * authored cap. A non-positive or non-finite duration always fails closed.
 */
export function isShortClipDuration(durationSeconds: number): boolean {
  return Number.isFinite(durationSeconds)
    && durationSeconds > 0
    && durationSeconds <= MAX_AUTOPLAY_CLIP_SECONDS + 0.1;
}

export function hasMeaningfulExtendedContextReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim().length >= MIN_EXTENDED_CONTEXT_REASON_LENGTH;
}

export function isValidClipWindow(startSeconds: number, endSeconds: number, role: 'prompt' | 'context', reason?: string | null): boolean {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) return false;
  return isShortClipWindow(startSeconds, endSeconds) || (role === 'context' && hasMeaningfulExtendedContextReason(reason));
}

export function isValidClipDuration(durationSeconds: number, role: 'prompt' | 'context', reason?: string | null): boolean {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
  return isShortClipDuration(durationSeconds) || (role === 'context' && hasMeaningfulExtendedContextReason(reason));
}
