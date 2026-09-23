import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { describeError } from './describe-error.mjs';

// SHA-256 of protocol|hostname|port|database|username for the reviewed MD3
// production Neon target. Credentials and query parameters are deliberately
// excluded, so password rotation does not change the attestation.
export const EXPECTED_PRODUCTION_DATABASE_TARGET_SHA256 =
  '8fd66437d64acaad501650dfed18b6657f23ff543e73b8fa893d569dd90e656e';
export const EXPECTED_PRODUCTION_DATABASE_UNPOOLED_TARGET_SHA256 =
  '01cf5e2737256ed62eb0f1251daa42f3412a4c17b8d90d83a66870c5be8c8435';

export function fingerprintDatabaseTarget(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  const canonical = [
    parsed.protocol,
    parsed.hostname.toLowerCase(),
    parsed.port || '5432',
    parsed.pathname.replace(/^\//, ''),
    decodeURIComponent(parsed.username),
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function verifyProductionDatabaseTarget(
  databaseUrl,
  expectedFingerprint = EXPECTED_PRODUCTION_DATABASE_TARGET_SHA256,
) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for production migration verification');
  const actual = fingerprintDatabaseTarget(databaseUrl);
  if (actual !== expectedFingerprint) {
    throw new Error('DATABASE_URL does not match the reviewed MD3 production database target');
  }
  return true;
}

export function verifyProductionDatabaseTargets({
  databaseUrl,
  databaseUrlUnpooled,
  expectedPooledFingerprint = EXPECTED_PRODUCTION_DATABASE_TARGET_SHA256,
  expectedUnpooledFingerprint = EXPECTED_PRODUCTION_DATABASE_UNPOOLED_TARGET_SHA256,
}) {
  verifyProductionDatabaseTarget(databaseUrl, expectedPooledFingerprint);
  try {
    verifyProductionDatabaseTarget(databaseUrlUnpooled, expectedUnpooledFingerprint);
  } catch (error) {
    throw new Error(
      `DATABASE_URL_UNPOOLED does not match the reviewed direct production target: ${
        describeError(error)
      }`,
    );
  }
  if (new URL(databaseUrl).hostname === new URL(databaseUrlUnpooled).hostname) {
    throw new Error('DATABASE_URL_UNPOOLED must use the reviewed direct production target, not the pooled host');
  }
  return true;
}

function main() {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });
  dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
  if (process.env.DATABASE_URL_LOCAL?.trim()) {
    throw new Error('DATABASE_URL_LOCAL must be unset for a production migration');
  }
  verifyProductionDatabaseTargets({
    databaseUrl: process.env.DATABASE_URL,
    databaseUrlUnpooled: process.env.DATABASE_URL_UNPOOLED,
  });
  console.log('Production pooled application and direct migration target fingerprints verified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(describeError(error));
    process.exit(1);
  }
}
