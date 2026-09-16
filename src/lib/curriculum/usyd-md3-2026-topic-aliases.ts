export type ReviewedMd3Rotation = 'critical-care' | 'paam' | 'cah' | 'pwh';

interface ReviewedTopicAliasGroup {
  canonicalTopic: string;
  aliases: readonly string[];
  evidence: readonly string[];
}

const EMPTY_GROUPS: Record<ReviewedMd3Rotation, readonly ReviewedTopicAliasGroup[]> = {
  'critical-care': [],
  paam: [],
  cah: [],
  pwh: [],
};

export const USYD_MD3_2026_TOPIC_ALIAS_ARTIFACT = {
  schema: 'md3.curriculum-topic-aliases/v1',
  revision: 0,
  reviewedAt: '1970-01-01T00:00:00.000Z',
  reviewedBy: 'public-fallback',
  groups: EMPTY_GROUPS,
} as const;

export function resolveReviewedMd3TopicAlias(
  _rotation: ReviewedMd3Rotation,
  _rawTopic: string,
): string | null {
  void _rotation;
  void _rawTopic;
  return null;
}
