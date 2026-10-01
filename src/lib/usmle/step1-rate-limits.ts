/** Per-user budgets for the public Step 1 learning loop. Guests are tighter. */

export const STEP1_RATE_WINDOW_MS = 60_000;

export const STEP1_SESSION_LIMIT = {
  signedIn: 20,
  guest: 8,
} as const;

export const STEP1_ANSWER_LIMIT = {
  signedIn: 60,
  guest: 20,
} as const;

export const STEP1_PROGRESS_LIMIT = {
  signedIn: 30,
  guest: 12,
} as const;

export function step1RateLimit(isGuest: boolean, limits: {
  signedIn: number;
  guest: number;
}): number {
  return isGuest ? limits.guest : limits.signedIn;
}
