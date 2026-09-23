/**
 * Typed re-export of the shared connect-budget guard.
 *
 * The implementation lives in `connect-resilience.mjs` so that the plain-`node`
 * release-gate scripts can import it too — they cannot load a `.ts` module, and
 * when they silently ran without this budget a cold Neon compute failed the
 * release with a phantom outage (2026-09-13). Import from either file; there is
 * one budget.
 */
export {
  NODE_DEFAULT_ATTEMPT_TIMEOUT_MS,
  NEON_CONNECT_ATTEMPT_TIMEOUT_MS,
  resolveConnectAttemptTimeout,
  applyConnectResilience,
} from './connect-resilience.mjs';
