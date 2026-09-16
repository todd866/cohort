/**
 * Keep the item a reader is currently looking at when a live batch replaces an
 * optimistic paint.
 *
 * The review feed paints the on-device pack immediately so the first frame is
 * fast, then issues the live session request and swaps the whole list in when
 * it lands. That swap is invisible only if the reader has already moved on —
 * otherwise the card they are mid-way through reading is replaced by a
 * different one, which is the "it shows one question then changes to another"
 * report. Nothing about the live batch requires the head to move: it is a set
 * of due items, not an ordered instruction, so leading it with the card
 * already on screen costs nothing and stops the yank.
 */
export function mergeOptimisticHead<T>(args: {
  /** The item painted from the pack and currently on screen, if any. */
  paintedHead: T | null;
  /** The live batch, already filtered and deduped. */
  incoming: T[];
  /** True once the reader has graded or skipped past the painted item. */
  readerHasAdvanced: boolean;
  /**
   * Keys the live response proved are no longer servable (offline tombstones).
   * A painted head in this set must not be resurrected.
   */
  excludedKeys?: ReadonlySet<string>;
  key: (item: T) => string;
}): T[] {
  const { paintedHead, incoming, readerHasAdvanced, excludedKeys, key } = args;
  if (!paintedHead || readerHasAdvanced) return incoming;

  const headKey = key(paintedHead);
  if (excludedKeys?.has(headKey)) return incoming;

  return [paintedHead, ...incoming.filter((item) => key(item) !== headKey)];
}
