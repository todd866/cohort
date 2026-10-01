import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { checkDestructiveSafety } from './destructive-guard.mjs';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/prisma-with-env.mjs <prisma args...>');
  console.error('Example: node scripts/prisma-with-env.mjs db push');
  process.exit(2);
}

const safety = checkDestructiveSafety({
  args,
  databaseUrl: process.env.DATABASE_URL,
  override: process.env.ALLOW_PROD_DESTRUCTIVE === '1',
});
if (safety.blocked) {
  console.error(`\n❌ ${safety.reason}\n`);
  process.exit(3);
}

const prismaBin = path.resolve(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prisma.cmd' : 'prisma'
);

const result = spawnSync(prismaBin, args, {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);

