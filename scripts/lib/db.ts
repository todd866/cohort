/**
 * Shared PrismaClient singleton for scripts.
 *
 * Usage:
 *   import { prisma } from './lib/db';
 *   // or from nested dirs:
 *   import { prisma } from '../lib/db';
 *
 * Handles:
 * - .env.local / .env loading (in correct priority order)
 * - PrismaNeon adapter with WebSocket by default
 * - Attested, single-connection PrismaPg escape hatch for serialized releases
 * - Singleton instance (safe to import from multiple modules)
 */
import { config } from 'dotenv';
import path from 'path';

// Load .env.local first (higher priority), then .env as fallback.
// dotenv won't overwrite existing vars, so .env.local wins.
const root = path.resolve(__dirname, '../..');
config({ path: path.join(root, '.env.local') });
config({ path: path.join(root, '.env') });

import { assertSupportedNodeMajor } from './node-version.mjs';
import { applyConnectResilience } from './connect-resilience';

assertSupportedNodeMajor();

// Raise Node's 250ms per-address connect budget above a cold Neon compute
// wake. Without this the first script of a session exhausts every resolved
// address in ~1.5s and reports an empty-message ETIMEDOUT that reads as a
// production outage. See connect-resilience.ts.
applyConnectResilience();

import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaPg } from '@prisma/adapter-pg';
import { neonConfig } from '@neondatabase/serverless';
import { resolveDatabaseTarget } from '../../src/lib/database-target';
import { resolveScriptDatabaseConnection } from './db-transport';
import { neonWebSocketConstructor } from './neon-websocket-proxy';

// Plain ws on the Mac; through HTTPS_PROXY in a cloud session, where 443 is the
// only way out and raw Postgres cannot pass.
neonConfig.webSocketConstructor = neonWebSocketConstructor();

const databaseTarget = resolveDatabaseTarget(process.env);
const databaseConnection = resolveScriptDatabaseConnection(databaseTarget, process.env);

// Announce target + transport, never a credential-bearing URL. A silent mirror
// fallback or transport switch produces plausible output until someone acts on
// the wrong provenance.
console.error(`[db] target: ${databaseConnection.provenance}`);

function createScriptPrismaClient() {
  const transactionOptions = {
    maxWait: 10_000,
    timeout: 120_000,
  };
  if (databaseConnection.adapter === 'pg') {
    const pgConfig = databaseConnection.maxConnections
      ? {
          connectionString: databaseConnection.connectionString!,
          connectionTimeoutMillis: databaseConnection.connectionTimeoutMillis,
          max: databaseConnection.maxConnections,
        }
      : { connectionString: databaseConnection.connectionString! };
    return new PrismaClient({
      adapter: new PrismaPg(pgConfig),
      transactionOptions,
    });
  }
  return new PrismaClient({
    adapter: new PrismaNeon({ connectionString: databaseConnection.connectionString! }),
    transactionOptions,
  });
}

export const prisma = createScriptPrismaClient();
