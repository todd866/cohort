/**
 * Marker for the synthetic Cohort answer-path probe.
 *
 * The Cohort funnel reported 100% hook abandonment, and that number was
 * UNFALSIFIABLE: nothing had ever exercised POST /api/cohort/answer, so a
 * broken write path and a genuinely uninterested audience produced identical
 * output. The probe answers a real question end to end to tell them apart.
 *
 * It therefore writes one real delivery + answer per run, which would otherwise
 * contaminate the very funnel it exists to validate. The probe sends a
 * serveRequestId carrying this prefix — persisted as `clientOperationId` — so
 * the audit can drop its rows and keep reporting only human behaviour.
 */
export const SMOKE_PROBE_PREFIX = 'smoke-probe-';

export function smokeProbeOperationId(nonce: string): string {
  return `${SMOKE_PROBE_PREFIX}${nonce}`;
}

export function isSmokeProbeOperation(clientOperationId: string | null | undefined): boolean {
  return typeof clientOperationId === 'string' && clientOperationId.startsWith(SMOKE_PROBE_PREFIX);
}
