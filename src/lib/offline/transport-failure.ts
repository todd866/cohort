/**
 * Did a write fail in transport (no response), rather than being refused by the
 * server? Every grade is written to the outbox before it is sent
 * (src/hooks/useGrading.ts), so a transport failure loses nothing: the answer
 * is queued and the connection chip shows it. Only a server refusal needs the
 * "not saving" alert. On 12 Oct 2026 the alert showed "TypeError: Failed
 * to fetch" on patchy signal for answers that were safely queued.
 */
export function isTransportFailure(message: string): boolean {
  if (/^HTTP \d{3}\b/.test(message)) return false;
  return /TypeError|Failed to fetch|NetworkError|Load failed|network connection was lost|timed out|AbortError|aborted/i.test(message);
}
