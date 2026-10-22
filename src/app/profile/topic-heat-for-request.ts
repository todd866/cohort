import { cache } from 'react';
import { loadTopicHeatmap } from '@/lib/knowledge/topic-heat.server';

/**
 * One topic-heatmap load per profile request. The exam row's readiness gauge
 * and the heatmap section both need it; `cache` makes them share the read, so
 * the gauge adds no query and the two can never show different numbers.
 */
export const loadTopicHeatmapForRequest = cache((userId: string) => loadTopicHeatmap(userId));
