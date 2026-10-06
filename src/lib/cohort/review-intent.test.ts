import { describe, expect, it } from 'vitest';
import { cohortReviewHref, parseCohortReviewIntent } from './review-intent';
import type { CohortSearchTopicV1 } from './search-topic-contract';

const topic = (id: string): CohortSearchTopicV1 => ({
  id,
  label: id,
  aliases: [],
  searchIntents: [],
  learningOutcomes: [],
  modalities: ['text'],
  eligibleItemCount: 1,
  eligibleAssetCount: 0,
});
const topics = [topic('module-anatomy'), topic('module-paeds'), topic('heart-function')];

describe('Cohort review intent', () => {
  it('maps the anatomy path and topic query to the admitted anatomy topic', () => {
    expect(parseCohortReviewIntent('/anatomy', topics)).toEqual({ topicId: 'module-anatomy', valid: true });
    expect(parseCohortReviewIntent('/?topic=module-anatomy', topics)).toEqual({ topicId: 'module-anatomy', valid: true });
  });

  it('rejects an explicit unknown topic instead of broadening to root', () => {
    expect(parseCohortReviewIntent('/?topic=private-module', topics)).toEqual({ topicId: null, valid: false });
    expect(parseCohortReviewIntent('/anatomy?topic=private-module', topics)).toEqual({ topicId: null, valid: false });
  });

  it('preserves unrelated and repeated query keys while canonicalizing focus', () => {
    expect(cohortReviewHref('/?tag=a&tag=b&topic=module-paeds&view=compact#focus', 'module-anatomy', topics))
      .toBe('/anatomy?tag=a&tag=b&view=compact#focus');
    expect(cohortReviewHref('/anatomy?tag=a&tag=b', 'module-paeds', topics))
      .toBe('/?tag=a&tag=b&topic=module-paeds');
  });

  it('clears focus to root and refuses an unadmitted selection', () => {
    expect(cohortReviewHref('/anatomy?topic=module-anatomy&topic=module-paeds&x=1', null, topics))
      .toBe('/?x=1');
    expect(cohortReviewHref('/?x=1', 'unknown', topics)).toBeNull();
  });

  it('does not create persistent enrollment state', () => {
    const href = cohortReviewHref('/?foo=bar', 'heart-function', topics);
    expect(href).toBe('/?foo=bar&topic=heart-function');
  });
});
