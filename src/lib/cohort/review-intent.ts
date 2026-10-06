import type { CohortSearchTopicV1 } from './search-topic-contract';

export const COHORT_ANATOMY_TOPIC_ID = 'module-anatomy';

export interface CohortReviewIntent {
  topicId: string | null;
  valid: boolean;
}

function asUrl(input: string | URL): URL {
  return input instanceof URL ? new URL(input.href) : new URL(input, 'https://cohort.md');
}

/** Parse only a server-admitted topic catalogue. An explicit unknown topic is
 * invalid rather than silently broadening to the root deck. */
export function parseCohortReviewIntent(
  input: string | URL,
  topics: readonly CohortSearchTopicV1[],
): CohortReviewIntent {
  const url = asUrl(input);
  const admitted = new Set(topics.map((topic) => topic.id));
  const topicsInUrl = url.searchParams.getAll('topic');
  if (new Set(topicsInUrl).size > 1) return {topicId: null, valid: false};
  const explicit = url.searchParams.get('topic');
  if (explicit !== null) return { topicId: admitted.has(explicit) ? explicit : null, valid: admitted.has(explicit) };
  if (url.pathname === '/anatomy' || url.pathname === '/anatomy/') {
    return { topicId: admitted.has(COHORT_ANATOMY_TOPIC_ID) ? COHORT_ANATOMY_TOPIC_ID : null, valid: admitted.has(COHORT_ANATOMY_TOPIC_ID) };
  }
  return { topicId: null, valid: true };
}

/** Serialize a reviewed topic without enrolling the learner or dropping other
 * query state. All existing topic keys are replaced by the selected focus. */
export function cohortReviewHref(
  current: string | URL,
  topicId: string | null,
  topics: readonly CohortSearchTopicV1[],
): string | null {
  const url = asUrl(current);
  const admitted = new Set(topics.map((topic) => topic.id));
  if (topicId !== null && !admitted.has(topicId)) return null;
  while (url.searchParams.has('topic')) url.searchParams.delete('topic');
  if (topicId === COHORT_ANATOMY_TOPIC_ID) {
    url.pathname = '/anatomy';
  } else if (topicId) {
    url.pathname = '/';
    url.searchParams.set('topic', topicId);
  } else {
    url.pathname = '/';
  }
  url.search = url.searchParams.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}
