#!/usr/bin/env node
/**
 * Audit and optionally soft-delete answer-bearing QuestionReinforcement cards
 * whose canonical parent Question belongs to the public Step 1 corpus.
 *
 * Default mode is read-only. Pass --apply during an authorized deployment or
 * maintenance window to perform the idempotent soft delete. No answer content
 * is printed; the report contains only row identities and routing metadata.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { Prisma } from '@prisma/client';
import { CHECKED_IN_OPEN_USMLE_RELEASE_IDS } from '../../src/lib/usmle/public-release-bundle';
import {
  resolveDatabaseTarget,
  type DatabaseTargetName,
} from '../../src/lib/database-target';

export interface RepairProtectedReinforcementArgs {
  apply: boolean;
  json: boolean;
}

export type ReinforcementDatabaseTarget = DatabaseTargetName;

/** Label the selected target without logging a credential-bearing URL. */
export function reinforcementDatabaseTarget(
  env: { DATABASE_URL_LOCAL?: string } = process.env,
): ReinforcementDatabaseTarget {
  return resolveDatabaseTarget(env).name;
}

export function parseRepairProtectedReinforcementArgs(
  argv: string[],
): RepairProtectedReinforcementArgs {
  const args = { apply: false, json: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

export type ProtectedReinforcementCandidate = {
  id: string;
  stableId: string | null;
  rotation: string;
};

const RELEASED_QUESTION_IDS = [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS];
const RELEASED_PRIMARY_STABLE_IDS = RELEASED_QUESTION_IDS.map(
  (questionId) => `qcard:${questionId}`,
);
const RELEASED_FACT_STABLE_PREFIXES = RELEASED_QUESTION_IDS.map(
  (questionId) => `qcard:${questionId}:fact:`,
);

export const protectedReinforcementCandidatesSql = Prisma.sql`
  SELECT DISTINCT
    c.id,
    c."stableId",
    c.rotation
  FROM "Card" c
  WHERE c."deletedAt" IS NULL
    AND (
      c."sourceComponent" = 'QuestionReinforcement'
      OR c."stableId" LIKE 'qcard:%'
    )
    AND (
      EXISTS (
        SELECT 1
        FROM "Question" q
        WHERE (
          q.id IN (${Prisma.join(RELEASED_QUESTION_IDS)})
          OR q.rotation = 'usmle-step1'
          OR 'usmle/step1' = ANY(q."moduleNodes")
        )
        AND (
          q."cardId" = c.id
          OR c."stableId" = 'qcard:' || q.id
          OR strpos(c."stableId", 'qcard:' || q.id || ':fact:') = 1
        )
      )
      OR c."stableId" IN (${Prisma.join(RELEASED_PRIMARY_STABLE_IDS)})
      OR (
        ${Prisma.join(
          RELEASED_FACT_STABLE_PREFIXES.map(
            (prefix) => Prisma.sql`strpos(c."stableId", ${prefix}) = 1`,
          ),
          ' OR ',
        )}
      )
    )
  ORDER BY c.id ASC
`;

export interface RepairProtectedReinforcementClient {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  card: {
    updateMany(args: {
      where: { id: { in: string[] }; deletedAt: null };
      data: { deletedAt: Date };
    }): Promise<{ count: number }>;
  };
}

export interface RepairProtectedReinforcementReport {
  schemaVersion: 1;
  mode: 'dry-run' | 'apply';
  candidateCount: number;
  retiredCount: number;
  candidates: ProtectedReinforcementCandidate[];
}

export async function repairProtectedReinforcementCards(
  client: RepairProtectedReinforcementClient,
  options: { apply: boolean; now?: Date },
): Promise<RepairProtectedReinforcementReport> {
  const candidates = await client.$queryRaw<ProtectedReinforcementCandidate[]>(
    protectedReinforcementCandidatesSql,
  );
  let retiredCount = 0;
  if (options.apply && candidates.length > 0) {
    const result = await client.card.updateMany({
      where: {
        id: { in: candidates.map((row) => row.id) },
        deletedAt: null,
      },
      data: { deletedAt: options.now ?? new Date() },
    });
    retiredCount = result.count;
  }
  return {
    schemaVersion: 1,
    mode: options.apply ? 'apply' : 'dry-run',
    candidateCount: candidates.length,
    retiredCount,
    candidates,
  };
}

async function main(): Promise<void> {
  const args = parseRepairProtectedReinforcementArgs(process.argv.slice(2));
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });
  dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
  const databaseTarget = reinforcementDatabaseTarget();
  const { prisma } = await import('../../src/lib/prisma');
  try {
    const report = await repairProtectedReinforcementCards(
      prisma as unknown as RepairProtectedReinforcementClient,
      { apply: args.apply },
    );
    if (args.json) {
      console.log(JSON.stringify({ ...report, databaseTarget }));
    } else {
      console.log(
        `Protected reinforcement repair [${databaseTarget}] (${report.mode}): `
        + `${report.candidateCount} active candidate(s), ${report.retiredCount} retired`,
      );
      for (const row of report.candidates) {
        console.log(`- ${row.id} (${row.stableId ?? 'no-stable-id'}, ${row.rotation})`);
      }
    }
    if (!args.apply && report.candidateCount > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
