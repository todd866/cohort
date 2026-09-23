/**
 * Shared Node-major guard for scripts that talk to the database.
 *
 * Node 20's global `fetch` has no happy-eyeballs across a host's multiple A
 * records, so a connect to Neon's `api.<region>.aws.neon.tech` (three A
 * records) can hang on a dead address and surface as:
 *
 *   Error connecting to database: TypeError: fetch failed
 *
 * That is indistinguishable from a real production outage, which is exactly
 * the failure `.claude/rules/diagnostic-provenance.md` exists to prevent — an
 * environment problem wearing a product problem's error message. Fail loudly
 * with the remediation instead.
 */
export const SUPPORTED_NODE_MAJOR = 24;
const MIN_NODE_MAJOR = 22;

export function assertSupportedNodeMajor(version = process.versions.node) {
  const match = /^(\d+)(?:\.|$)/.exec(version);
  if (!match) return; // unparseable — don't block on a shape we don't understand
  const major = Number(match[1]);
  if (major >= MIN_NODE_MAJOR) return;

  throw new Error(
    `This script requires Node ${SUPPORTED_NODE_MAJOR}.x (found ${version}). ` +
      "Node <" + MIN_NODE_MAJOR + " lacks multi-address fetch fallback, so Neon connects " +
      'fail as a misleading "Error connecting to database: TypeError: fetch failed" ' +
      'that reads like a production outage. Run `nvm use` and retry.',
  );
}
