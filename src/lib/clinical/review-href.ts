import type { Station } from './station-types';

/** A focused review of a station's topics (the review deep link takes rotation + topics). */
export function stationReviewHref(station: Pick<Station, 'review'>, topics: string[] = station.review.topics): string {
  return `/?${new URLSearchParams({ rotation: station.review.rotation, topics: topics.join(',') })}`
    .replace(/\+/g, '%20')
    .replace(/'/g, '%27');
}
