import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Generation and offline builds need a syntactically valid URL but never connect.
// Port 1 makes accidental database commands fail closed unless DATABASE_URL is set.
const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://foss:foss@127.0.0.1:1/foss';

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema'),
  migrations: {
    path: path.join(__dirname, 'prisma', 'migrations'),
    seed: 'node --import tsx scripts/usmle/seed-open-corpus.ts',
  },
  datasource: {
    url: databaseUrl,
  },
  // Prisma's current config types lag the runtime support for migrate adapters.
  // @ts-expect-error runtime-supported, but missing from PrismaConfig typing
  migrate: {
    adapter: async () => {
      const pg = await import('pg');
      return new pg.default.Pool({ connectionString: databaseUrl });
    },
  },
});
