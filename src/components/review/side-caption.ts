/**
 * Whether a tall figure's caption goes beside the image or below it.
 *
 * Both directions are judged by one number: the image's full height-fitted
 * width, measured while stacked (the frame plus the caption height it gives
 * up). Beside, the CSS caps the image at the pane minus 10rem, so a width
 * measured there cannot say whether the image would fit; judging that capped
 * width by a stricter rule than the one that put the caption beside made the
 * two layouts trigger each other on every resize, and the page strobed (owner
 * flag, 16 Nov 2026). Once beside, it stays until the room is short by more
 * than a scrollbar's width.
 */
export const SIDE_CAPTION_MIN_PX = 160;
export const SIDE_CAPTION_SLACK_PX = 24;

export interface SideCaptionMemo { fullWidth: number; viewportHeight: number }

export function decideSideCaption(input: {
  available: number;
  /** The image frame's rendered width in the current layout. */
  width: number;
  beside: boolean;
  notesSpacePx: number;
  ratio: number;
  viewportHeight: number;
  memo: SideCaptionMemo | null;
}): { beside: boolean; memo: SideCaptionMemo | null } {
  const { available, width, beside, notesSpacePx, ratio, viewportHeight } = input;
  if (!beside) {
    const fullWidth = width + notesSpacePx * ratio;
    const memo = { fullWidth, viewportHeight };
    return { beside: available - fullWidth >= SIDE_CAPTION_MIN_PX, memo };
  }
  // The figure height follows the viewport one for one, so its full width follows it by the ratio.
  const fullWidth = input.memo
    ? input.memo.fullWidth + (viewportHeight - input.memo.viewportHeight) * ratio
    : width;
  return { beside: available - fullWidth >= SIDE_CAPTION_MIN_PX - SIDE_CAPTION_SLACK_PX, memo: input.memo };
}
