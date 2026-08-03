// Guardrail against running destructive Prisma operations against a non-local
// (i.e. production Neon) database. Added after the deep-dive audit found that
// `prisma-with-env.mjs` passed `--force-reset` / `--accept-data-loss` straight
// through with no protection, and the prod DATABASE_URL is loaded from
// .env.local — so a mistyped `npm run db:push -- --force-reset` could wipe prod.
// See also memory feedback_database_url_local_trap.
//
// Policy: destructive ops are allowed ONLY against a localhost DB, unless the
// operator sets ALLOW_PROD_DESTRUCTIVE=1 to explicitly opt in. Unknown/garbage
// URLs are treated as non-local (fail safe).

const DESTRUCTIVE_FLAGS = ['--force-reset', '--accept-data-loss'];

/** True if the prisma argv performs a destructive (data-losing) operation. */
export function isDestructive(args) {
  if (args.some((a) => DESTRUCTIVE_FLAGS.includes(a))) return true;
  // `db push` bypasses the reviewed migration history and can drop/reshape
  // production objects as the datamodel changes. It is allowed only for an
  // explicitly local disposable database (or the emergency override below).
  if (args[0] === 'db' && args[1] === 'push') return true;
  // `prisma migrate reset` drops and recreates the schema.
  if (args[0] === 'migrate' && args[1] === 'reset') return true;
  return false;
}

/** True only if the DATABASE_URL clearly points at a local host. Fail safe: anything we can't parse as local is treated as remote. */
export function isLocalDatabaseUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let host;
  try {
    // URL() needs a parseable scheme; postgres URLs parse fine.
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!host) return false;
  const h = host.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * Decide whether a prisma invocation should be blocked.
 * @returns {{ blocked: boolean, reason: string }}
 */
export function checkDestructiveSafety({ args, databaseUrl, override }) {
  if (!isDestructive(args)) return { blocked: false, reason: '' };
  if (override) return { blocked: false, reason: '' };
  if (isLocalDatabaseUrl(databaseUrl)) return { blocked: false, reason: '' };
  const op = args.join(' ');
  return {
    blocked: true,
    reason:
      `Refusing destructive prisma op (\`${op}\`) against a non-local database.\n` +
      `DATABASE_URL does not point at localhost. This guard exists to prevent wiping production.\n` +
      `If you really mean to do this against the current target, re-run with ALLOW_PROD_DESTRUCTIVE=1.`,
  };
}
