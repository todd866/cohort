/**
 * How long a Neon WebSocket connection may take to be acquired.
 *
 * Production identity telemetry is sharply bimodal: healthy first DB touches
 * finish below 2s, while acquisition stalls start at 7.6s and run to 186s. A
 * deployed request must therefore fail fast rather than hold a serverless
 * invocation open.
 *
 * Local CLI tooling has the opposite constraint. The Neon WebSocket handshake
 * from a home connection is an order of magnitude slower than it is inside
 * Vercel's network — measured at ~3.08s against the 3.0s cap on 2026-09-11 —
 * so the serverless bound made every morning-check diagnostic that imports the
 * app client fail with "Connection terminated due to connection timeout" while
 * the database itself answered in ~100ms over direct TCP. That blinded 79
 * scripts, including `audit:review-load-health`, `audit:scheduler-health` and
 * `audit:flag-health`.
 *
 * The bound is therefore chosen by execution context, never relaxed globally.
 */

export interface NeonTimeoutEnvironment {
  [key: string]: string | undefined;
  VERCEL?: string;
  NEXT_RUNTIME?: string;
}

/** Bound for a deployed request. Deliberately tight; do not raise. */
export const SERVERLESS_NEON_CONNECTION_TIMEOUT_MS = 3_000;

/** Bound for a script or CLI run outside the Next.js server. */
export const LOCAL_TOOLING_NEON_CONNECTION_TIMEOUT_MS = 15_000;

/**
 * True when this process is serving a Next.js request, on Vercel or locally.
 * A `tsx` script run from a shell matches neither marker.
 */
function isServerRuntime(env: NeonTimeoutEnvironment): boolean {
  return Boolean(env.VERCEL) || Boolean(env.NEXT_RUNTIME);
}

export function resolveNeonConnectionTimeoutMs(
  env: NeonTimeoutEnvironment = process.env,
): number {
  return isServerRuntime(env)
    ? SERVERLESS_NEON_CONNECTION_TIMEOUT_MS
    : LOCAL_TOOLING_NEON_CONNECTION_TIMEOUT_MS;
}
