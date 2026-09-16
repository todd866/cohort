export interface FlagSummary {
  issueId: string;
  issueType: string;
  rotation: string | null;
  targetType: string;
  targetId: string;
  reportMessage: string | null;
  reportReason: string | null;
  createdAt: Date;
}

export interface FlagCluster {
  pattern: string;        // human-readable label e.g. "truncated-options"
  rootCauseHint: string | null; // e.g. "extraction-artifact", "generation-prompt", "content-gap"
  count: number;
  rotation: string | null;
  issueIds: string[];
  sampleMessages: string[];
}

interface PatternRule {
  keywords: string[];
  label: string;
  rootCause: string;
}

const PATTERN_RULES: PatternRule[] = [
  {
    keywords: ['cut off', 'truncated', 'incomplete'],
    label: 'truncated-options',
    rootCause: 'extraction-artifact',
  },
  {
    keywords: ['giveaway', 'obvious', 'too easy', 'deducible'],
    label: 'giveaway-answer',
    rootCause: 'generation-prompt',
  },
  {
    keywords: ['amplification', 'expand', 'more context', 'one-sentence', 'needs context'],
    label: 'needs-context',
    rootCause: 'content-gap',
  },
  {
    keywords: ['formatting', 'format'],
    label: 'formatting',
    rootCause: 'formatting',
  },
  {
    keywords: ['incorrect', 'wrong', 'inaccurate'],
    label: 'medical-accuracy',
    rootCause: 'medical-accuracy',
  },
  {
    keywords: ['rewrite'],
    label: 'needs-rewrite',
    rootCause: 'generation-prompt',
  },
  {
    keywords: ['acronym', 'tla', 'abbreviation'],
    label: 'unexpanded-acronym',
    rootCause: 'content-gap',
  },
];

function detectPattern(flag: FlagSummary): { label: string; rootCause: string } | null {
  const text = [flag.reportMessage, flag.reportReason]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!text) return null;

  for (const rule of PATTERN_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return { label: rule.label, rootCause: rule.rootCause };
    }
  }

  return null;
}

function clusterKey(pattern: string, rotation: string | null): string {
  return `${pattern}:${rotation ?? '__null__'}`;
}

export function clusterFlags(flags: FlagSummary[]): FlagCluster[] {
  if (flags.length === 0) return [];

  const clusterMap = new Map<string, FlagCluster>();

  for (const flag of flags) {
    const detected = detectPattern(flag);

    const pattern = detected?.label ?? flag.issueType;
    const rootCause = detected?.rootCause ?? null;
    const key = clusterKey(pattern, flag.rotation);

    const existing = clusterMap.get(key);
    if (existing) {
      existing.count += 1;
      existing.issueIds.push(flag.issueId);
      // Collect message for sampling (we'll trim to 3 later)
      const msg = flag.reportMessage ?? flag.reportReason;
      if (msg) {
        existing.sampleMessages.push(msg);
      }
    } else {
      const msg = flag.reportMessage ?? flag.reportReason;
      clusterMap.set(key, {
        pattern,
        rootCauseHint: rootCause,
        count: 1,
        rotation: flag.rotation,
        issueIds: [flag.issueId],
        sampleMessages: msg ? [msg] : [],
      });
    }
  }

  const clusters = Array.from(clusterMap.values());

  // Trim sample messages to at most 3
  for (const cluster of clusters) {
    if (cluster.sampleMessages.length > 3) {
      cluster.sampleMessages = cluster.sampleMessages.slice(0, 3);
    }
  }

  // Sort by count descending
  clusters.sort((a, b) => b.count - a.count);

  return clusters;
}
