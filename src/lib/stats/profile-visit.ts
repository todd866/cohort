/** Optional factual recall estimate. No personality or career inference. */
import { estimatedKnowledgeFromHistogram, knowledgeSparkline, type HistogramBin } from './stats-model';

export interface ProfileVisitModel {
  /** Cards the learner would recall today. Null when none are scheduled. */
  knowledge: number | null;
  /** Up to 30 daily estimates. Null when there is no series to draw. */
  trend: number[] | null;
}

export function toProfileVisit(data: {
  retrievability: readonly HistogramBin[];
  trend?: readonly number[] | null;
}): ProfileVisitModel {
  return {
    knowledge: estimatedKnowledgeFromHistogram(data.retrievability),
    trend: knowledgeSparkline(data.trend ?? null),
  };
}
