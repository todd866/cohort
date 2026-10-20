'use client';

/**
 * The public build has no AI: md3's api/tutor and the agent that answers it
 * are private to md3.info, so the review bar renders without it.
 */
export interface AiReviewControlProps {
  access: 'owner' | 'learner' | 'guest' | null;
  target: { kind: 'card' | 'question'; id: string } | null;
  label: string;
}

export function AiReviewControl(_props: AiReviewControlProps) {
  return null;
}
