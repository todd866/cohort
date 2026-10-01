/**
 * Figure URLs for the items just ahead of the one on screen.
 *
 * Review images are only requested when their card mounts, so a card carrying
 * a figure shows an empty box while its bytes download — several seconds on a
 * full-resolution clinical image, and worse under the sensitive-media gate,
 * where the blurred container has no height until the image arrives (recorded
 * 2026-08-22). The delivered batch already contains the upcoming items and
 * their URLs, so the bytes can be in the browser cache before the learner ever
 * presses next.
 *
 * Kept deliberately small and pure: the caller owns the lookahead depth, and
 * the React side does nothing but warm whatever this returns.
 */
export interface UpcomingImageItem {
  imageUrl?: string | null;
}

export function upcomingImageUrls(
  items: readonly UpcomingImageItem[],
  currentIndex: number,
  lookahead: number,
): string[] {
  if (lookahead <= 0) return [];
  const start = Math.max(0, currentIndex) + 1;
  const urls: string[] = [];
  const seen = new Set<string>();

  for (let i = start; i < items.length && urls.length < lookahead; i += 1) {
    const url = items[i]?.imageUrl;
    if (typeof url !== 'string' || url.length === 0) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
}
