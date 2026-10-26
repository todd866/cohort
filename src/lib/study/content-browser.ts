/** Manual content browsing only; never called by the scheduler. */
export const BROWSER_PAGE_SIZE = 20;
export const BROWSER_HISTORY_LIMIT = 40;
export type BrowserStatus = 'seen' | 'unseen';
export interface BrowserQuery {
  type: 'card' | 'question';
  status: 'all' | BrowserStatus;
  q: string;
  topic: string;
  cluster: string;
  source: string;
  rotation: string;
  item: string | null;
  cursor: string | null;
}
function filters(query: Omit<BrowserQuery, 'cursor'>) {
  return [query.type, query.status, query.q, query.topic, query.cluster, query.source, query.rotation, query.item];
}
export function parseBrowserQuery(params: URLSearchParams): BrowserQuery {
  const type = params.get('type') ?? 'card';
  const status = params.get('status') ?? 'all';
  const values = ['q', 'topic', 'source', 'rotation', 'cluster'].map(key => (params.get(key) ?? '').trim());
  const item = params.get('item');
  if (!['card', 'question'].includes(type) || !['all', 'seen', 'unseen'].includes(status)
    || values.some(value => value.length > 120) || (item !== null && (!item || item.length > 200))) throw new Error('Invalid browser filters');
  const [q, topic, source, rotation, cluster] = values;
  if (type === 'question' && cluster) throw new Error('Cluster browsing supports cards only');
  const query: BrowserQuery = { type: type as BrowserQuery['type'], status: status as BrowserQuery['status'], q, topic, cluster, source, rotation, item, cursor: null };
  const cursor = params.get('cursor');
  if (cursor !== null) {
    if (!cursor || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid browser cursor');
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (JSON.stringify(decoded.filters) !== JSON.stringify(filters(query)) || typeof decoded.id !== 'string'
        || !decoded.id || decoded.id.length > 200 || item) throw new Error();
      query.cursor = decoded.id;
    } catch { throw new Error('Invalid browser cursor'); }
  }
  return query;
}
export function browserCursor(query: BrowserQuery, id: string): string {
  return Buffer.from(JSON.stringify({ filters: filters(query), id })).toString('base64url');
}
/** Count overlapping stores conservatively, never sum the same answer twice. */
export function browserEvidence(recordedAnswers: number, eventLast: Date | null, legacyCount: number, legacyLast: Date | null, legacySource: 'legacy-progress' | 'question-responses') {
  const fallback = Math.max(legacyCount, legacyLast ? 1 : 0);
  const reviewCount = Math.max(recordedAnswers, fallback);
  const last = [eventLast, legacyLast].filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    status: reviewCount > 0 ? 'seen' as const : 'unseen' as const,
    reviewCount,
    reviewCountSource: fallback > recordedAnswers ? legacySource : 'events' as const,
    recordedEventCount: recordedAnswers,
    historyComplete: false,
    lastReviewedAt: last?.toISOString() ?? null,
  };
}
export const BROWSER_HISTORY_NOTE = 'Reviews count completed answers. Counts use retained events or the larger saved review count; older history may be incomplete. Unseen means no recorded completed review, not proof the item was never displayed.';
