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
 * - PrismaNeon adapter with WebSocket (works through firewalls)
 * - Singleton instance (safe to import from multiple modules)
 */
import { config } from 'dotenv';
import path from 'path';

// Load .env.local first (higher priority), then .env as fallback.
// dotenv won't overwrite existing vars, so .env.local wins.
const root = path.resolve(__dirname, '../..');
config({ path: path.join(root, '.env.local') });
config({ path: path.join(root, '.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaPg } from '@prisma/adapter-pg';
import { neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { resolveDatabaseTarget } from '../../src/lib/database-target';

neonConfig.webSocketConstructor = ws;

const databaseTarget = resolveDatabaseTarget(process.env);

function createScriptPrismaClient() {
  const transactionOptions = {
    maxWait: 10_000,
    timeout: 120_000,
  };
  if (databaseTarget.name === 'local-mirror') {
    return new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseTarget.connectionString! }),
      transactionOptions,
    });
  }
  return new PrismaClient({
    adapter: new PrismaNeon({ connectionString: databaseTarget.connectionString! }),
    transactionOptions,
  });
}

export const prisma = createScriptPrismaClient();
