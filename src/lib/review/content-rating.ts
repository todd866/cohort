import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';

export type ContentRating = 'good' | 'bad';

export interface PostContentRatingInput {
  itemType: 'card' | 'question';
  itemId: string;
  /**
   * Exact delivered-item trace. The API copies all scheduler context from the
   * ServeDecision, so a rating without one cannot be anchored to what the
   * learner actually saw and is not worth recording.
   */
  serveDecisionId: string | undefined;
  /** null clears an existing rating, so pressing the same key twice un-rates. */
  rating: ContentRating | null;
  sourceComponent: string;
}

/**
 * One path to /api/study/content-rating, shared by the thumb buttons and the
 * g/b keyboard shortcuts. Kept in one place so the two cannot drift: the
 * buttons shipped alone and recorded zero ratings, and a second independent
 * copy for the keyboard would be the same bug waiting to happen.
 *
 * Returns whether the rating was stored. Never throws — a failed rating must
 * not interrupt a review session.
 */
export async function postContentRating({
  itemType,
  itemId,
  serveDecisionId,
  rating,
  sourceComponent,
}: PostContentRatingInput): Promise<boolean> {
  if (!serveDecisionId) return false;

  try {
    const response = await fetchWithDeadline('/api/study/content-rating', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemType,
        itemId,
        serveDecisionId,
        rating: rating ?? 'clear',
        sourceComponent,
      }),
    }, CLIENT_FETCH_DEADLINE_MS);
    return response.ok;
  } catch {
    return false;
  }
}
