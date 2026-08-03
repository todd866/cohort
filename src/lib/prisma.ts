// Guard: server-only throws outside Next.js (e.g. prisma seed, scripts)
// eslint-disable-next-line @typescript-eslint/no-require-imports
try { require('server-only'); } catch {}
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaPg } from '@prisma/adapter-pg';
import { neonConfig } from '@neondatabase/serverless';
import { incrementQueryCount } from '@/lib/observability/query-counter';
import { withoutRawPublicUsmleReinforcementCards } from '@/lib/usmle/raw-reinforcement-card-boundary';
import { resolveDatabaseTarget } from '@/lib/database-target';

// Counts every DB operation (incl. raw queries) issued inside an active
// withQueryCounting() scope; a no-op otherwise. Drives per-session query-count
// telemetry for the scheduler. Applied to every client branch below.
const queryCountingExtension = {
  name: 'query-counting',
  query: {
    async $allOperations({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) {
      incrementQueryCount();
      return query(args);
    },
  },
} as const;

// In Node.js (local dev, seed scripts), use the `ws` package for WebSocket.
// In Vercel Edge/Serverless, native WebSocket is available.
if (typeof WebSocket === 'undefined') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    neonConfig.webSocketConstructor = require('ws');
  } catch {
    // ws not available — fall through and let Neon try native WebSocket
  }
}

const databaseTarget = resolveDatabaseTarget(process.env);

/** True when using the local Postgres mirror instead of Neon. */
export const isLocalMirror = databaseTarget.name === 'local-mirror';

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

function createPrismaClient() {
  // Local mirror: use standard pg adapter (no Neon WebSocket).
  // Set DATABASE_URL_LOCAL=postgresql://localhost/md3_mirror in .env.local.
  if (databaseTarget.name === 'local-mirror') {
    const adapter = new PrismaPg({ connectionString: databaseTarget.connectionString! });
    const base = new PrismaClient({
      adapter,
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
    return extendPrismaClient(base);
  }

  const adapter = new PrismaNeon({ connectionString: databaseTarget.connectionString! });
  const base = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
  return extendPrismaClient(base);
}

/** Apply behavior-changing extensions identically to every database adapter. */
function extendPrismaClient(base: PrismaClient) {
  // ---------------------------------------------------------------------------
  // Card read boundary: auto-filter deleted cards and answer-bearing
  // QuestionReinforcement rows derived from protected public Step 1 questions.
  // Cards with deletedAt set are excluded from findMany/findFirst/count.
  // To include soft-deleted cards, put an explicit deletedAt condition at the
  // top level of the query, for example: { deletedAt: { not: null } }.
  // ---------------------------------------------------------------------------
  const withCardReadBoundaries = (
    input: Prisma.CardWhereInput | undefined,
  ): Prisma.CardWhereInput => {
    const where: Prisma.CardWhereInput = { ...(input ?? {}) };
    if (!('deletedAt' in where)) where.deletedAt = null;

    // Keep unique keys at the top level for findUnique/findUniqueOrThrow. A
    // top-level unique key plus additional filters is supported; burying the
    // unique key inside AND is not a valid CardWhereUniqueInput.
    const boundary = withoutRawPublicUsmleReinforcementCards(where);
    const boundaryParts = Array.isArray(boundary.AND) ? boundary.AND.slice(1) : [];
    const existingAnd = Array.isArray(where.AND)
      ? where.AND
      : where.AND
        ? [where.AND]
        : [];
    return {
      ...where,
      AND: [...existingAnd, ...boundaryParts],
    };
  };

  return base.$extends({
    name: 'card-soft-delete',
    query: {
      card: {
        async findMany({ args, query }) {
          args.where = withCardReadBoundaries(args.where);
          return query(args);
        },
        async findFirst({ args, query }) {
          args.where = withCardReadBoundaries(args.where);
          return query(args);
        },
        async findFirstOrThrow({ args, query }) {
          args.where = withCardReadBoundaries(args.where);
          return query(args);
        },
        async findUnique({ args, query }) {
          args.where = withCardReadBoundaries(args.where) as typeof args.where;
          return query(args);
        },
        async findUniqueOrThrow({ args, query }) {
          args.where = withCardReadBoundaries(args.where) as typeof args.where;
          return query(args);
        },
        async count({ args, query }) {
          args.where = withCardReadBoundaries(args.where);
          return query(args);
        },
      },
    },
  }).$extends(queryCountingExtension);
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

/** The runtime type of the extended Prisma client (use instead of PrismaClient). */
export type ExtendedPrismaClient = typeof prisma;

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
