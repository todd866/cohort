/**
 * Durable audit projection for the clinical concept-thread policy receipt.
 *
 * Both ServeDecision.payload and LearningEvent.metadata carry the same public
 * field names. Keep parsing and aggregation here so the scheduler-health and
 * walk audits use identical coverage denominators and fail-closed semantics.
 */
export interface ConceptThreadMetadata {
  conceptThreadPolicyVersion: string | null;
  conceptThreadPolicyApplied: boolean | null;
  conceptThreadAnchorEventId: string | null;
  conceptThreadAnchorItemId: string | null;
  conceptThreadAnchorFacet: string | null;
  conceptThreadTargetFacet: string | null;
  conceptThreadSharedTopic: string | null;
  conceptThreadAgeMs: number | null;
  conceptThreadInterveningExposures: number | null;
}

export interface ConceptThreadTelemetry {
  /** Delivered/exposed question receipts in the caller-owned denominator. */
  eligibleCount: number;
  /** Eligible receipts with a valid, non-empty policy version. */
  policyObservedCount: number;
  policyCoverage: number | null;
  /** Covered receipts on which the policy explicitly reported applied=true. */
  appliedCount: number;
  /** appliedCount / policyObservedCount, not / eligibleCount. */
  appliedRate: number | null;
  /** Applied receipts carrying every anchor/facet/topic/cadence field. */
  completeAppliedCount: number;
  medianAgeMs: number | null;
  ageSampleCount: number;
  medianInterveningExposures: number | null;
  interveningExposureSampleCount: number;
  answeredAppliedCount: number;
  appliedCorrectCount: number;
  appliedCorrectnessRate: number | null;
}

export interface ConceptThreadTelemetryObservation {
  metadata: unknown;
  /** Observed outcome for this question, null/omitted while unanswered. */
  isCorrect?: boolean | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function parseConceptThreadMetadata(value: unknown): ConceptThreadMetadata {
  const metadata = asRecord(value);
  return {
    conceptThreadPolicyVersion: nonEmptyString(metadata.conceptThreadPolicyVersion),
    conceptThreadPolicyApplied: booleanOrNull(metadata.conceptThreadPolicyApplied),
    conceptThreadAnchorEventId: nonEmptyString(metadata.conceptThreadAnchorEventId),
    conceptThreadAnchorItemId: nonEmptyString(metadata.conceptThreadAnchorItemId),
    conceptThreadAnchorFacet: nonEmptyString(metadata.conceptThreadAnchorFacet),
    conceptThreadTargetFacet: nonEmptyString(metadata.conceptThreadTargetFacet),
    conceptThreadSharedTopic: nonEmptyString(metadata.conceptThreadSharedTopic),
    conceptThreadAgeMs: nonNegativeFiniteNumber(metadata.conceptThreadAgeMs),
    conceptThreadInterveningExposures: nonNegativeSafeInteger(
      metadata.conceptThreadInterveningExposures,
    ),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function hasCompleteAppliedEvidence(metadata: ConceptThreadMetadata): boolean {
  return metadata.conceptThreadAnchorEventId !== null
    && metadata.conceptThreadAnchorItemId !== null
    && metadata.conceptThreadAnchorFacet !== null
    && metadata.conceptThreadTargetFacet !== null
    && metadata.conceptThreadSharedTopic !== null
    && metadata.conceptThreadAgeMs !== null
    && metadata.conceptThreadInterveningExposures !== null;
}

export function computeConceptThreadTelemetry(
  observations: readonly ConceptThreadTelemetryObservation[],
): ConceptThreadTelemetry {
  const parsed = observations.map(observation => ({
    metadata: parseConceptThreadMetadata(observation.metadata),
    isCorrect: typeof observation.isCorrect === 'boolean'
      ? observation.isCorrect
      : null,
  }));
  const observed = parsed.filter(
    observation => observation.metadata.conceptThreadPolicyVersion !== null,
  );
  // An orphan applied=true without a version is not a usable policy receipt.
  const applied = observed.filter(
    observation => observation.metadata.conceptThreadPolicyApplied === true,
  );
  const ages = applied
    .map(observation => observation.metadata.conceptThreadAgeMs)
    .filter((value): value is number => value !== null);
  const interveningExposures = applied
    .map(observation => observation.metadata.conceptThreadInterveningExposures)
    .filter((value): value is number => value !== null);
  const answeredApplied = applied.filter(observation => observation.isCorrect !== null);
  const correctApplied = answeredApplied.filter(observation => observation.isCorrect === true);

  return {
    eligibleCount: parsed.length,
    policyObservedCount: observed.length,
    policyCoverage: parsed.length === 0 ? null : observed.length / parsed.length,
    appliedCount: applied.length,
    appliedRate: observed.length === 0 ? null : applied.length / observed.length,
    completeAppliedCount: applied.filter(
      observation => hasCompleteAppliedEvidence(observation.metadata),
    ).length,
    medianAgeMs: median(ages),
    ageSampleCount: ages.length,
    medianInterveningExposures: median(interveningExposures),
    interveningExposureSampleCount: interveningExposures.length,
    answeredAppliedCount: answeredApplied.length,
    appliedCorrectCount: correctApplied.length,
    appliedCorrectnessRate: answeredApplied.length === 0
      ? null
      : correctApplied.length / answeredApplied.length,
  };
}

function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return '<1m';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  const value = ms < 24 * 60 * 60_000
    ? ms / (60 * 60_000)
    : ms / (24 * 60 * 60_000);
  const unit = ms < 24 * 60 * 60_000 ? 'h' : 'd';
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}${unit}`;
}

function formatMedian(value: number | null): string {
  if (value === null) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** One privacy-safe Morning Check line: no raw ids, facets, or clinical topics. */
export function formatConceptThreadTelemetryLine(
  telemetry: ConceptThreadTelemetry,
): string {
  return `Concept thread (questions): policy coverage ${telemetry.policyObservedCount}/${telemetry.eligibleCount} (${formatPercent(telemetry.policyCoverage)})`
    + ` · applied ${telemetry.appliedCount}/${telemetry.policyObservedCount} (${formatPercent(telemetry.appliedRate)})`
    + ` · evidence ${telemetry.completeAppliedCount}/${telemetry.appliedCount} complete`
    + ` · median age ${formatDuration(telemetry.medianAgeMs)} (n=${telemetry.ageSampleCount})`
    + ` · median intervening ${formatMedian(telemetry.medianInterveningExposures)} (n=${telemetry.interveningExposureSampleCount})`
    + ` · answered ${telemetry.answeredAppliedCount}/${telemetry.appliedCount}`
    + ` · correct ${formatPercent(telemetry.appliedCorrectnessRate)}`;
}
