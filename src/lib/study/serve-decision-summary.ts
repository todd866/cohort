export interface SummaryInput {
  decisionPath: string;
  deliveryPath?: 'cached' | 'live' | null;
  queueReason?: string;
  rankInPool?: number;
  poolSize?: number;
  predictedRecall?: number;
  conceptLabel?: string;
  exclusionCount?: number;
  variantSibling?: boolean;
  payload?: Record<string, unknown>;
}

const PATH_VERB: Record<string, string> = {
  'manifold-walk': 'Selected by manifold walk',
  starter: 'Served from starter pool',
  rereview: 'Served via rereview',
  instant: 'Served by instant pathway',
  focused: 'Served by focused-session pathway',
  'cache-refresh': 'Queued by background cache refresh',
};

const REASON_PHRASE: Record<string, string> = {
  'weak-concept': 'because card matched a weak concept',
  due: 'because card was due',
  'failed-today': 'because card was failed earlier today',
  'failed-yesterday': 'because card was failed yesterday',
  starter_session: 'as part of a starter session',
  precompute: 'for next-request reuse',
  'scaffold-after-miss': 'as a scaffold after a miss',
};

function assertNoEmbedding(payload: Record<string, unknown>) {
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value) && value.length > 8 && value.every((v) => typeof v === 'number')) {
      throw new Error(
        `Refusing to format ServeDecision summary: payload field '${key}' looks like an embedding (number[${value.length}]).`,
      );
    }
  }
}

export function formatServeDecisionSummary(input: SummaryInput): string {
  if (input.payload) assertNoEmbedding(input.payload);

  const verb = PATH_VERB[input.decisionPath] ?? `Decided by ${input.decisionPath}`;
  const reason = input.queueReason ? REASON_PHRASE[input.queueReason] ?? `because ${input.queueReason}` : null;
  const concept = input.conceptLabel ? `'${input.conceptLabel}'` : null;

  const head = input.deliveryPath === null && input.decisionPath === 'cache-refresh'
    ? 'Queued for cache reuse'
    : verb;

  const reasonClause = reason
    ? concept ? `${reason} ${concept}` : reason
    : null;

  const scalars: string[] = [];
  if (input.rankInPool != null && input.poolSize != null) {
    scalars.push(`rank ${input.rankInPool}/${input.poolSize}`);
  } else if (input.poolSize != null) {
    scalars.push(`pool size ${input.poolSize}`);
  }
  if (input.predictedRecall != null) {
    scalars.push(`pre-serve item proxy ${input.predictedRecall.toFixed(2)}`);
  }

  const exclusion = input.exclusionCount != null && input.exclusionCount > 0
    ? `excluded ${input.exclusionCount} candidates`
    : null;

  const parts = [head, reasonClause, scalars.length ? scalars.join(', ') : null, exclusion]
    .filter(Boolean)
    .join('; ');

  return input.deliveryPath === 'cached' ? `Cached delivery: ${parts}` : parts;
}
