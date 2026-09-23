/**
 * Shared connect-budget guard for scripts that talk to the database.
 *
 * Sibling of `node-version.mjs`, and the same class of bug: an environment
 * problem wearing a production problem's error message.
 *
 * Node's happy-eyeballs (`autoSelectFamily`) gives EACH resolved address only
 * 250ms by default. Neon's endpoint resolves to 3 A + 3 AAAA records, and this
 * machine has no IPv6 default route, so the AAAA attempts fail instantly with
 * EHOSTUNREACH and the A attempts each get 250ms. A *cold* Neon compute takes
 * 2-5s to wake, which no single 250ms attempt can survive — so all six
 * addresses are exhausted in ~1.5s and the connect rejects with:
 *
 *   AggregateError [ETIMEDOUT]:            <- note the empty message
 *
 * That is indistinguishable from a real outage, and it is intermittent by
 * construction: it strikes the FIRST database script of a session (cold
 * compute) and disappears once something else has woken the endpoint, which is
 * exactly how it survived as folklore ("Neon was down this morning") instead of
 * being diagnosed. Measured 2026-09-01: default budget failed at 1588ms; a
 * raised budget connected in 2932ms and queried normally.
 *
 * Raise the per-address budget above the cold-start wake. This cannot mask a
 * genuine outage: the overall `connectionTimeoutMillis` still bounds the
 * connect, so a truly unreachable database still fails, just with an honest
 * error instead of a 1.5s phantom one.
 *
 * This file is `.mjs` ON PURPOSE. The `tsx` lane reaches it through
 * `connect-resilience.ts`, but the release-gate scripts that decide whether a
 * deploy may proceed run under plain `node` and cannot import a `.ts` module at
 * all. Keeping the implementation here is what lets BOTH lanes share one
 * budget; when it lived in the `.ts` file the gate scripts silently ran on
 * Node's 250ms default and failed the release with a phantom outage
 * (2026-09-13), which is exactly the folklore this guard exists to end.
 */
import net from 'node:net';

/** Node's compiled-in default, which this guard exists to raise. */
export const NODE_DEFAULT_ATTEMPT_TIMEOUT_MS = 250;

/** Comfortably clears an observed 2.0-2.9s Neon cold-start wake. */
export const NEON_CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Decide the per-address connect budget, never lowering one an operator raised
 * deliberately (e.g. via --network-family-autoselection-attempt-timeout).
 *
 * @param {number | undefined} current
 * @returns {number}
 */
export function resolveConnectAttemptTimeout(current) {
  if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) {
    return NEON_CONNECT_ATTEMPT_TIMEOUT_MS;
  }
  return Math.max(current, NEON_CONNECT_ATTEMPT_TIMEOUT_MS);
}

/**
 * Apply the budget to this process. Safe to call more than once.
 *
 * @returns {number}
 */
export function applyConnectResilience() {
  const current = net.getDefaultAutoSelectFamilyAttemptTimeout?.();
  const resolved = resolveConnectAttemptTimeout(current);
  net.setDefaultAutoSelectFamilyAttemptTimeout?.(resolved);
  return resolved;
}
