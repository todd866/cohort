/**
 * Which bitmap the learner is looking at. An occlusion prompt is a masked
 * bitmap (the answer box burned in by scripts/images/flowchart-occlusion.ts);
 * its sidecar's `revealImageKey` is the clean base shown after reveal. The
 * review surface (CardImage) and the tutor image loader both choose through
 * this one function, so the tutor never sees more than the screen shows.
 */
export function displayedImageKey<K extends string | null | undefined>(imageKey: K, revealImageKey: string | undefined | null, revealed: boolean): K | string {
  return revealed && revealImageKey ? revealImageKey : imageKey;
}
