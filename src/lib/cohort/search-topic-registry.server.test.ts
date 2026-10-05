import { describe, expect, it } from 'vitest';
import {
  COHORT_SEARCH_TOPIC_REGISTRY,
  questionMatchesCohortSearchTopic,
  resolveCohortSearchTopic,
} from './search-topic-registry.server';

describe('Cohort anatomy module topic', () => {
  it('registers anatomy as a module-scoped public topic', () => {
    const topic = resolveCohortSearchTopic('module-anatomy');
    expect(topic).toMatchObject({
      id: 'module-anatomy',
      moduleNode: 'cohort/anatomy',
      modalities: ['text'],
    });
    expect(COHORT_SEARCH_TOPIC_REGISTRY).toContain(topic);
  });

  it('matches only released anatomy module membership, never ordinary tags', () => {
    const topic = resolveCohortSearchTopic('module-anatomy');
    expect(topic).not.toBeNull();
    expect(questionMatchesCohortSearchTopic({
      rotation: 'cohort-open',
      moduleNodes: ['cohort/anatomy'],
      topics: [],
    }, topic!)).toBe(true);
    expect(questionMatchesCohortSearchTopic({
      rotation: 'cohort-open',
      moduleNodes: ['cohort/neuro'],
      topics: ['anatomy'],
    }, topic!)).toBe(false);
    expect(questionMatchesCohortSearchTopic({
      rotation: 'usmle-step1-open',
      moduleNodes: ['cohort/anatomy'],
      topics: [],
    }, topic!)).toBe(false);
  });
});
