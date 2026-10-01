export function normalizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toTitleCaseTopic(topic: string): string {
  const normalized = normalizeTopic(topic);
  if (!normalized) return '';
  const smallWords = new Set([
    'and',
    'or',
    'the',
    'a',
    'an',
    'of',
    'to',
    'for',
    'in',
    'on',
    'with',
    'without',
    'vs',
    'versus',
  ]);
  return normalized
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      if (word.length <= 3 && !smallWords.has(word)) return word.toUpperCase();
      return word[0]?.toUpperCase() + word.slice(1);
    })
    .join(' ');
}

export function expandTopicVariants(topic: string): string[] {
  const trimmed = topic.trim();
  const normalized = normalizeTopic(trimmed);
  const title = normalized ? toTitleCaseTopic(normalized) : '';
  const smartCaps = normalized
    ? normalized
        .split(' ')
        .filter(Boolean)
        .map((word) => {
          if (word.length <= 3 && word !== 'and' && word !== 'or' && word !== 'the') {
            return word.toUpperCase();
          }
          return word;
        })
        .join(' ')
    : '';

  const variants = new Set<string>();
  if (trimmed) variants.add(trimmed);
  if (normalized) variants.add(normalized);
  if (title) variants.add(title);
  if (smartCaps) variants.add(smartCaps);

  // Short tokens are often acronyms (bls, als, abg, tbi, txa, etc.)
  if (/^[a-z0-9]{2,5}$/.test(normalized)) {
    variants.add(normalized.toUpperCase());
  }

  return [...variants];
}

export function expandTopicSet(topics: string[]): string[] {
  const expanded: string[] = [];
  for (const topic of topics) {
    expanded.push(...expandTopicVariants(topic));
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of expanded) {
    const t = raw.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    result.push(t);
  }
  return result;
}
