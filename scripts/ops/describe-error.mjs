/**
 * Render a thrown value into something a human can act on.
 *
 * Exists because Node's AggregateError — what `pg` and `undici` throw when
 * every resolved address fails — leaves `message` EMPTY and puts the detail in
 * `code` and `errors`. Callers doing the idiomatic
 * `error instanceof Error ? error.message : String(error)` therefore print a
 * blank line. On 2026-08-22 that cost two release aborts whose entire output
 * was `Could not connect to database. Error: ` and a bare blank line; the
 * cause (an intermittent Neon ETIMEDOUT) had to be recovered by hand.
 *
 * Sibling of the release runner's signal reporting: a check that fails must
 * say why, not merely that it failed.
 *
 * AND IT MUST NOT SAY IT WITH A PASSWORD IN IT. The errors this helper exists
 * to render are `pg` connect failures, which are the errors most likely to
 * carry a full connection string — and its output goes into release logs and
 * agent transcripts. On 2026-09-14 a production Neon password reached a
 * transcript because a redaction elsewhere matched `postgres://` while the URL
 * was `postgresql://`: a check keyed to a SPELLING rather than to the thing it
 * guards. This module had no redaction at all.
 */

/**
 * The credential shapes, defined once. Three consumers read this list:
 * redactCredentials below (logs and transcripts), the tracked-file scanner
 * (scripts/ops/secret-scan.mjs, `npm run secrets:scan`) and the tutor daemon's
 * answer hold (scripts/tutor/answer-guard.ts). Two copies of a credential
 * regex is the failure this module exists to prevent: the second one drifts
 * and nobody notices until it is in a log.
 *
 * Each shape matches the SECRET, not the syntax around it, where it can (an
 * `npg_` Neon password in prose, not only inside a URL). Patterns carry no
 * flags beyond case; callers add `g` themselves (lastIndex is per-regex state).
 *
 * `trackedFiles: false` marks a shape the tracked-file scan leaves out because
 * the repo legitimately documents it (postgresql://user:password@host
 * examples); it still counts in a log line or a tutor answer.
 */
export const POSTGRES_URL_SOURCE = /\bpostgres(?:ql)?(?:\+[a-z0-9]+)?:\/\/[^\s'"`<>]+/.source;
export const CREDENTIAL_SHAPES = Object.freeze([
  { name: 'Postgres connection URL', pattern: new RegExp(POSTGRES_URL_SOURCE, 'i'), trackedFiles: false },
  // Neon passwords are npg_ plus a short random tail; match the token itself.
  { name: 'Neon password', pattern: /\bnpg_[A-Za-z0-9]{8,}\b/ },
  // OpenAI (sk-, sk-proj-) and Anthropic (sk-ant-) keys share the sk- prefix.
  // Case-sensitive with a word boundary: SK-N-SH and risk-benefit do not match.
  { name: 'OpenAI/Anthropic key', pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'Google OAuth client secret', pattern: /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/ },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Resend key', pattern: /\bre_[A-Za-z0-9]{20,}\b/ },
  // The header alone counts: a truncated answer may hold half a key.
  { name: 'Private key block', pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/, trackedFiles: false },
]);

/** A whole private key block, END line optional (a truncated paste still goes). */
export const PRIVATE_KEY_BLOCK_SOURCE = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/.source;

/**
 * The names of every credential shape in `text`, in list order. Names only:
 * a caller logging why it refused something never needs the value.
 */
export function findCredentialShapes(text) {
  if (typeof text !== 'string' || !text) return [];
  return [...new Set(CREDENTIAL_SHAPES.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name))];
}

/**
 * Covers both scheme spellings, the `+`-suffixed forms (postgresql+ssl://), a
 * bare `npg_` Neon credential with no URL around it (a password can surface in
 * prose: "password authentication failed for npg_..."), and every other shape
 * in CREDENTIAL_SHAPES.
 */
export function redactCredentials(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text
    .replace(new RegExp(PRIVATE_KEY_BLOCK_SOURCE, 'g'), '[redacted]')
    .replace(new RegExp(POSTGRES_URL_SOURCE, 'gi'), 'postgresql://[redacted]');
  for (const { name, pattern } of CREDENTIAL_SHAPES) {
    if (name === 'Postgres connection URL' || name === 'Private key block') continue;
    out = out.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), '[redacted]');
  }
  return out;
}

/**
 * Database settings whose VALUES an operator readout may print: the statement,
 * lock and idle-transaction time limits, and pgvector's four HNSW runtime
 * settings. A role, a database or a session can carry any setting at all,
 * including a custom one that holds a key or a token, so a readout prints a
 * value only when its name is listed here AND the value has the shape that
 * setting takes. The shape matters too: an hnsw.* value stored before pgvector
 * was loaded is an unvalidated placeholder and could hold any text.
 *
 * An allowlist, not a denylist of secret-looking names, for the reason the
 * credential pattern above exists: a check keyed to a spelling misses the next
 * spelling.
 */
const DURATION_SETTING = /^\d+(?:us|ms|s|min|h|d)?$/;
const PRINTABLE_SETTING_SHAPES = new Map([
  ['statement_timeout', DURATION_SETTING],
  ['lock_timeout', DURATION_SETTING],
  ['idle_in_transaction_session_timeout', DURATION_SETTING],
  ['hnsw.ef_search', /^\d+$/],
  ['hnsw.iterative_scan', /^(?:off|relaxed_order|strict_order)$/],
  ['hnsw.max_scan_tuples', /^\d+$/],
  ['hnsw.scan_mem_multiplier', /^\d+(?:\.\d+)?$/],
]);

/** True for an allowlisted setting name, before its value is considered. */
export function isPrintableSettingName(name) {
  return PRINTABLE_SETTING_SHAPES.has(name);
}

/** True when a setting's value may be printed: an allowlisted name and its expected shape. */
export function isPrintableSetting(name, value) {
  const shape = PRINTABLE_SETTING_SHAPES.get(name);
  return shape !== undefined && typeof value === 'string' && shape.test(value);
}

/** `name=value` for a printable setting, `name=<redacted>` for every other. */
export function printableSetting(name, value) {
  return isPrintableSetting(name, value) ? `${name}=${value}` : `${name}=<redacted>`;
}
export function describeError(error) {
  if (!(error instanceof Error)) return redactCredentials(String(error));

  const parts = [];
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  if (message) parts.push(message);
  else parts.push(error.name || 'Error');

  const code = error.code;
  if (typeof code === 'string' && code && !message.includes(code)) {
    parts.push(`(code ${code})`);
  }

  const causes = Array.isArray(error.errors) ? error.errors : [];
  if (causes.length > 0) {
    const distinct = [...new Set(
      causes.map((cause) => (cause instanceof Error ? cause.message : String(cause))).filter(Boolean),
    )];
    parts.push(`— ${causes.length} cause(s): ${distinct.slice(0, 3).join('; ')}`);
  }

  // Redact at the ONE exit, not per-branch: a new branch added later inherits
  // the redaction instead of having to remember it.
  return redactCredentials(parts.join(' '));
}
