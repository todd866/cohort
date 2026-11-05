// Owner, 5 Nov 2026: most cards should carry a picture or a clip, so the feed
// prefers them while coverage catches up. This is a tie-break, smaller than
// any pacing or ladder step, and it never overrides relevance.
import { PACING_AHEAD_PENALTY } from './curriculum-pacing';

export const MEDIA_PRESENCE_BOOST = -(PACING_AHEAD_PENALTY / 3);

export function mediaPresenceBoost(
  imageUrl: string | null | undefined,
  clipId: string | null | undefined,
): number {
  return (typeof imageUrl === 'string' && imageUrl !== '') || (typeof clipId === 'string' && clipId !== '')
    ? MEDIA_PRESENCE_BOOST
    : 0;
}
