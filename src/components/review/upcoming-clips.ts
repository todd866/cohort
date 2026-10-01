/**
 * Clip URLs for the items just ahead of the one on screen.
 *
 * A prompt clip only starts downloading when its card mounts. An eight-second
 * file is small, but "play immediately" means the bytes have to already be
 * in the cache when the learner presses next. The delivered batch already
 * holds the signed URLs.
 *
 * Same shape as upcomingImageUrls: the caller owns the lookahead depth.
 */
export interface UpcomingClipItem {
  clip?: { url?: string | null } | null;
}

export function upcomingClipUrls(
  items: readonly UpcomingClipItem[],
  currentIndex: number,
  lookahead: number,
): string[] {
  if (lookahead <= 0) return [];
  const start = Math.max(0, currentIndex) + 1;
  const urls: string[] = [];
  const seen = new Set<string>();

  for (let i = start; i < items.length && urls.length < lookahead; i += 1) {
    const url = items[i]?.clip?.url;
    if (typeof url !== 'string' || url.length === 0) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
}
