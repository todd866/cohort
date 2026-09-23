import type { ResolvedDatabaseTarget } from '../../src/lib/database-target';
import {
  EXPECTED_PRODUCTION_DATABASE_TARGET_SHA256,
  EXPECTED_PRODUCTION_DATABASE_UNPOOLED_TARGET_SHA256,
  verifyProductionDatabaseTargets,
} from '../ops/verify-production-db-target.mjs';

interface ScriptDatabaseEnvironment {
  [key: string]: string | undefined;
  DATABASE_URL?: string;
  DATABASE_URL_LOCAL?: string;
  DATABASE_URL_UNPOOLED?: string;
  /** Vercel's documented alias for the same non-pooling endpoint. */
  DATABASE_POSTGRES_URL_NON_POOLING?: string;
  MD3_DB_TRANSPORT?: string;
}

interface ReviewedTargetFingerprints {
  expectedPooledFingerprint?: string;
  expectedUnpooledFingerprint?: string;
}

const DIRECT_CONNECTION_TIMEOUT_MS = 10_000 as const;

export type ScriptDatabaseConnection =
  | {
      adapter: 'neon';
      connectionString: string | undefined;
      provenance: string;
    }
  | {
      adapter: 'pg';
      connectionString: string | undefined;
      connectionTimeoutMillis?: typeof DIRECT_CONNECTION_TIMEOUT_MS;
      maxConnections?: 1;
      provenance: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown target-attestation failure';
}

/**
 * Resolve the adapter and one connection target used by a script process.
 *
 * Direct production access is intentionally an exact opt-in. It is attested
 * against both reviewed endpoints and capped at one pool connection so a
 * future fan-out script cannot consume the unpooled connection budget.
 */
export function resolveScriptDatabaseConnection(
  databaseTarget: ResolvedDatabaseTarget,
  env: ScriptDatabaseEnvironment = process.env,
  fingerprints: ReviewedTargetFingerprints = {},
): ScriptDatabaseConnection {
  if (databaseTarget.name === 'local-mirror') {
    return {
      adapter: 'pg',
      connectionString: databaseTarget.connectionString,
      provenance: 'local-mirror · transport: direct-postgres · endpoint: local-mirror',
    };
  }

  const requestedTransport = env.MD3_DB_TRANSPORT?.trim();
  if (!requestedTransport) {
    return {
      adapter: 'neon',
      connectionString: databaseTarget.connectionString,
      provenance: 'configured-database · transport: neon-websocket · endpoint: configured',
    };
  }
  if (requestedTransport !== 'direct') {
    throw new Error('MD3_DB_TRANSPORT must be unset or exactly "direct"');
  }

  const directCandidates = [
    ['DATABASE_URL_UNPOOLED', env.DATABASE_URL_UNPOOLED?.trim()],
    ['DATABASE_POSTGRES_URL_NON_POOLING', env.DATABASE_POSTGRES_URL_NON_POOLING?.trim()],
  ].filter((candidate): candidate is [string, string] => Boolean(candidate[1]));

  if (directCandidates.length === 0) {
    throw new Error(
      'MD3_DB_TRANSPORT=direct requires DATABASE_URL_UNPOOLED or '
        + 'DATABASE_POSTGRES_URL_NON_POOLING',
    );
  }

  const expectedPooledFingerprint = fingerprints.expectedPooledFingerprint
    ?? EXPECTED_PRODUCTION_DATABASE_TARGET_SHA256;
  const expectedUnpooledFingerprint = fingerprints.expectedUnpooledFingerprint
    ?? EXPECTED_PRODUCTION_DATABASE_UNPOOLED_TARGET_SHA256;

  // Attest every supplied alias. Silently preferring one would let a stale,
  // mismatched second endpoint survive until a different script chose it.
  for (const [variableName, directUrl] of directCandidates) {
    try {
      verifyProductionDatabaseTargets({
        databaseUrl: databaseTarget.connectionString,
        databaseUrlUnpooled: directUrl,
        expectedPooledFingerprint,
        expectedUnpooledFingerprint,
      });
    } catch (error) {
      throw new Error(`${variableName} failed production target attestation: ${errorMessage(error)}`);
    }
  }

  // pg currently treats sslmode=require as certificate-verifying, but its next
  // major will adopt libpq's weaker meaning. Pin the reviewed direct session to
  // explicit hostname + certificate verification now.
  const directConnectionUrl = new URL(directCandidates[0][1]);
  directConnectionUrl.searchParams.set('sslmode', 'verify-full');

  return {
    adapter: 'pg',
    connectionString: directConnectionUrl.toString(),
    connectionTimeoutMillis: DIRECT_CONNECTION_TIMEOUT_MS,
    maxConnections: 1,
    provenance: 'configured-database · transport: direct-postgres · endpoint: reviewed-unpooled',
  };
}
