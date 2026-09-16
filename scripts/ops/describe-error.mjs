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
 * One pattern, exported, because two copies of a credential regex is the same
 * failure again — the second one drifts and nobody notices until it is in a log.
 *
 * Covers both scheme spellings, the `+`-suffixed forms (postgresql+ssl://), and
 * a bare `npg_` Neon credential with no URL around it, since a password can
 * surface in prose ("password authentication failed for npg_...").
 */
export function redactCredentials(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/\bpostgres(?:ql)?(?:\+[a-z0-9]+)?:\/\/[^\s'"`<>]+/gi, 'postgresql://[redacted]')
    .replace(/\bnpg_[A-Za-z0-9]{16,}\b/g, '[redacted]');
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
