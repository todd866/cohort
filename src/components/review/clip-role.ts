/**
 * The clip-as-prompt render contract, kept out of the `'use client'` component
 * so server modules (`review-panes.ts`, the session builders) can import the
 * predicate without pulling a React component into their bundle. Same split as
 * `image-role.ts` and for the same reason.
 */

export interface ClipPromptData {
  /** VideoClip id — what the delivery route re-signs when the URL expires. */
  id: string;
  url: string;
  posterUrl: string | null;
  audioStripped: boolean;
  sourceUrl: string;
  sourceTitle: string;
  startSecs: number;
  endSecs: number;
}

/**
 * A clip is the stem when the source row says so AND the clip actually
 * resolved. The second half is not redundant: `resolveClipForDelivery` returns
 * null whenever rights, tier or soft-delete deny the clip, and a prompt slot
 * holding nothing leaves a cloze that cannot be answered. Falling back to the
 * text-only card is the graceful failure; an empty pane is not.
 */
export function clipIsPrompt(
  clipRole: string | null | undefined,
  clip: ClipPromptData | null | undefined,
): boolean {
  return clipRole === 'prompt' && Boolean(clip?.url);
}
