/**
 * Connection settings for every DIRECT (unpooled) node-postgres session that a
 * script or a release step opens.
 *
 * node-postgres turns on no TCP keepalive and no query deadline by default. A
 * socket waiting for a reply sends nothing, so when the server end disappears
 * without a FIN or RST (a compute restart, a network change) the wait has no
 * end. A release step hung for 41 minutes that way before anyone noticed.
 *
 * Two detectors, because they catch different failures:
 *
 *   keepalive  probes start after 10 s of silence. Node sets 10 probes one
 *              second apart (its default since v13.12), so a peer that has
 *              gone is noticed in about 20 s, as a socket error the client
 *              surfaces. It also keeps NAT state alive on a long idle session.
 *   deadline   `query_timeout` rejects a query that has had no reply in time:
 *              the case keepalive cannot see, an endpoint that still answers
 *              probes but never answers the query. It is client side only and
 *              does not cancel a backend that is alive, so it sits well above
 *              any server ceiling (the role default, or a job's own SET), and
 *              the server always cancels first when it can.
 *
 * Server timeouts: a session with a client deadline gets a statement_timeout
 * just under it (see directPgOptions), and may choose others. A direct session
 * is the caller's alone, so it may pass `serverLimits`, written as startup
 * `options`, which outrank role and database defaults. A pooled connection
 * must never do this (PgBouncer does not forward startup parameters); it uses
 * SET LOCAL inside its transaction, through src/lib/db/statement-budget.ts.
 *
 * Because startup options outrank role defaults, a session that READS those
 * defaults (an operator reporting the role's statement_timeout, or proving on
 * a fresh session that a change took) must carry none of its own: it passes
 * `inheritServerDefaults: true` and reads back what the role gives it.
 *
 * `.mjs` on purpose, like connect-resilience.mjs: the release gates run under
 * plain node and cannot import a `.ts` module.
 */

/** Matches the existing direct-session connect bound. */
export const DIRECT_CONNECT_TIMEOUT_MS = 10_000;

/** Whole seconds: Node rounds the delay down to seconds, and 0 means "OS default". */
export const DIRECT_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/**
 * Default client deadline for one query. Generous on purpose: the largest
 * release read is a few tens of seconds on a good link and several times that
 * on a tethered one, and this only has to beat a hang, not a slow query.
 */
export const DIRECT_QUERY_DEADLINE_MS = 10 * 60_000;

/** The session limits a direct session may set for itself, in emission order. */
const SERVER_LIMIT_SETTINGS = ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'];

/**
 * @param {Partial<Record<'statement_timeout' | 'lock_timeout' | 'idle_in_transaction_session_timeout', number>>} limits
 * @returns {string} startup options, e.g. `-c statement_timeout=60000ms`
 */
function serverLimitOptions(limits) {
  for (const setting of Object.keys(limits)) {
    if (!SERVER_LIMIT_SETTINGS.includes(setting)) {
      throw new TypeError(`Unknown session limit setting: ${setting}`);
    }
  }
  return SERVER_LIMIT_SETTINGS
    .filter((setting) => limits[setting] !== undefined)
    .map((setting) => {
      const ms = limits[setting];
      if (!Number.isSafeInteger(ms) || ms < 0) {
        throw new TypeError(`${setting} must be a non-negative whole number of milliseconds`);
      }
      // 0 is PostgreSQL's "no limit": only for a session that legitimately waits.
      return `-c ${setting}=${ms === 0 ? '0' : `${ms}ms`}`;
    })
    .join(' ');
}

/**
 * The server statement_timeout paired with a client deadline: 10% below it,
 * by at most 30 s, never under 1 s.
 * @param {number} queryTimeoutMs
 */
export function serverDeadlineBelow(queryTimeoutMs) {
  return Math.max(1_000, queryTimeoutMs - Math.min(30_000, Math.floor(queryTimeoutMs * 0.1)));
}

/**
 * @param {object} [options]
 * @param {number} [options.queryTimeoutMs] client deadline per query; 0 for
 *   none, only for a session that legitimately waits (a blocking lock).
 * @param {string} [options.applicationName]
 * @param {Partial<Record<'statement_timeout' | 'lock_timeout' | 'idle_in_transaction_session_timeout', number>>} [options.serverLimits]
 *   session limits in milliseconds, for a direct session only
 * @param {boolean} [options.inheritServerDefaults] true for a session that
 *   reads the role and database defaults: no server limit is added beyond
 *   the ones `serverLimits` names, so every other setting is what the role
 *   gives a new session. Its client deadline then has no server cancel paired
 *   with it, so keep such a session to short catalog reads.
 * @returns {{
 *   connectionTimeoutMillis: number,
 *   keepAlive: true,
 *   keepAliveInitialDelayMillis: number,
 *   query_timeout?: number,
 *   application_name?: string,
 *   options?: string,
 * }}
 */
export function directPgOptions({
  queryTimeoutMs = DIRECT_QUERY_DEADLINE_MS,
  applicationName,
  serverLimits,
  inheritServerDefaults = false,
} = {}) {
  if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 0) {
    throw new TypeError('queryTimeoutMs must be a non-negative whole number of milliseconds');
  }
  if (typeof inheritServerDefaults !== 'boolean') {
    throw new TypeError('inheritServerDefaults must be true or false');
  }
  // A client deadline alone does not stop the query: node-postgres rejects the
  // call but sends no cancel, so the backend runs on (an orphan). Unless the
  // caller chose a server limit itself, or reads the role's own defaults, give
  // the session a statement_timeout just under the client deadline so the
  // server cancels first.
  const limits = { ...(serverLimits ?? {}) };
  if (queryTimeoutMs > 0 && limits.statement_timeout === undefined && !inheritServerDefaults) {
    limits.statement_timeout = serverDeadlineBelow(queryTimeoutMs);
  }
  const options = Object.keys(limits).length > 0 ? serverLimitOptions(limits) : '';
  return {
    connectionTimeoutMillis: DIRECT_CONNECT_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: DIRECT_KEEPALIVE_INITIAL_DELAY_MS,
    ...(queryTimeoutMs > 0 ? { query_timeout: queryTimeoutMs } : {}),
    ...(applicationName ? { application_name: applicationName } : {}),
    ...(options ? { options } : {}),
  };
}
