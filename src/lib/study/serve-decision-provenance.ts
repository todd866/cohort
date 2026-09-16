export const SERVE_DECISION_PROVENANCE = 'serve-decision' as const;

export const SERVE_DECISION_LINK_METADATA_KEYS = {
  provenance: 'serveDecisionProvenance',
  id: 'serveDecisionId',
} as const;

export const PREDICTED_RECALL_METADATA_KEYS = [
  'predictedRecall',
  'predictedRecallModel',
  'predictedRecallSource',
  'predictedRecallStatus',
  'predictedRecallProvenance',
  'predictedRecallServeDecisionId',
] as const;

export const SERVER_AUTHORED_STUDY_METADATA_KEYS = [
  ...PREDICTED_RECALL_METADATA_KEYS,
  SERVE_DECISION_LINK_METADATA_KEYS.provenance,
  SERVE_DECISION_LINK_METADATA_KEYS.id,
] as const;

/** Metadata written only after a ServeDecision is scoped to this user and item. */
export function trustedServeDecisionLinkMetadata(serveDecisionId: string) {
  return {
    [SERVE_DECISION_LINK_METADATA_KEYS.provenance]: SERVE_DECISION_PROVENANCE,
    [SERVE_DECISION_LINK_METADATA_KEYS.id]: serveDecisionId,
  } as const;
}

/** Read the server-authored link shared by answer writes and offline audits. */
export function trustedServeDecisionIdFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const values = metadata as Record<string, unknown>;
  const id = values[SERVE_DECISION_LINK_METADATA_KEYS.id];
  return values[SERVE_DECISION_LINK_METADATA_KEYS.provenance] === SERVE_DECISION_PROVENANCE
    && typeof id === 'string'
    && id.length > 0
    ? id
    : null;
}
