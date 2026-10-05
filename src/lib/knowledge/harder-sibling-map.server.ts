/**
 * Static map of harder sibling question id → anchor question id.
 *
 * CONTENT, not user history. One small read of the question table, cached in
 * process memory. A failed refresh keeps the last good map. A failed first
 * read returns an empty map and is logged once, so a harder sibling is served
 * as an ordinary question rather than holding the request. An anchor that is
 * shelved or deleted is omitted here, which releases its sibling.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { HARDER_SIBLING_VARIANT_TYPE } from './question-retirement';

export const HARDER_SIBLING_MAP_TTL_MS = 10 * 60 * 1000;

let cached: { at: number; map: Map<string, string> } | null = null;
let pending: Promise<Map<string, string>> | null = null;
let loggedColdFailure = false;

export function clearHarderSiblingMapCache(): void {
  cached = null;
  pending = null;
  loggedColdFailure = false;
}

function rowsToMap(rows: ReadonlyArray<{ id: string; variantGroupId: string | null }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.id && row.variantGroupId) map.set(row.id, row.variantGroupId);
  }
  return map;
}

async function readHarderSiblingMap(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<Array<{ id: string; variantGroupId: string | null }>>(Prisma.sql`
    SELECT q.id, q."variantGroupId"
    FROM "Question" q
    WHERE q."variantType" = ${HARDER_SIBLING_VARIANT_TYPE}
      AND q."contentState" <> 'shelved'
      AND q."variantGroupId" IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM "Question" anchor
        WHERE anchor.id = q."variantGroupId"
          AND anchor."contentState" <> 'shelved'
      )
  `);
  return rowsToMap(Array.isArray(rows) ? rows : []);
}

export async function loadHarderSiblingMap(nowMs = Date.now()): Promise<ReadonlyMap<string, string>> {
  if (cached && nowMs - cached.at < HARDER_SIBLING_MAP_TTL_MS) return cached.map;
  if (pending) return pending;

  const startedAt = nowMs;
  pending = readHarderSiblingMap()
    .then((map) => {
      cached = { at: startedAt, map };
      loggedColdFailure = false;
      return map;
    })
    .catch((error: unknown) => {
      if (cached) return cached.map;
      if (!loggedColdFailure) {
        loggedColdFailure = true;
        logger.warn('harder sibling map unavailable; serving those questions without the hold', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return new Map<string, string>();
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}
