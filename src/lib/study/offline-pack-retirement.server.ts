import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ownerPrivateOrSharedCardScope, scopedCardSqlPredicate } from '@/lib/cards/read-repository.server';
import { withholdsFromServing } from '@/lib/content-quality/withholding-severity';

export const PACK_VALIDATION_LIMIT = 100;
type PackIdentity = { type: 'card' | 'question'; id: string };

/** Bound both SQL work and URL size. These are identities, never delivery exclusions. */
export function parsePackIdentities(params: URLSearchParams): PackIdentity[] {
  const items: PackIdentity[] = [];
  const seen = new Set<string>();
  for (const [type, param] of [['card', 'packCards'], ['question', 'packQuestions']] as const) {
    for (const id of (params.get(param) ?? '').split(',', PACK_VALIDATION_LIMIT)) {
      const key = `${type}:${id}`;
      if (!id || id.length > 128 || !/^[a-zA-Z0-9:_-]+$/.test(id) || seen.has(key)) continue;
      seen.add(key);
      items.push({ type, id });
      if (items.length === PACK_VALIDATION_LIMIT) return items;
    }
  }
  return items;
}

/**
 * Status-only primary-key reads, independent of rotation/week/media selection.
 * The session starts this alongside its existing user read, not after hydration.
 * No review history, content bodies, new request, or retirement-write plumbing.
 * Throws on failure: callers must not mistake an unavailable check for approval.
 */
export async function loadRetiredPackKeys(userId: string, items: readonly PackIdentity[]): Promise<string[]> {
  if (items.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ key: string; unavailable: boolean; issueTypes: string[] | null }>>(Prisma.sql`
    /* offline_pack_retirement */
    WITH requested(type, id) AS (VALUES ${Prisma.join(items.map(item => Prisma.sql`(${item.type}, ${item.id})`))})
    SELECT r.type || ':' || r.id AS key,
      CASE WHEN r.type = 'card' THEN
        c.id IS NULL OR c."deletedAt" IS NOT NULL OR c."shelvedAt" IS NOT NULL
        OR NOT (${scopedCardSqlPredicate(ownerPrivateOrSharedCardScope(userId), 'c')})
        OR c.topics && ARRAY['_needs-image', '_incomplete-data']::text[]
      ELSE
        q.id IS NULL OR q.excluded OR q."contentState" IN ('shelved', 'retired', 'raw')
        OR q.explanation IS NULL OR q.topics && ARRAY['_needs-image', '_incomplete-data']::text[]
      END AS unavailable,
      ARRAY(SELECT i."issueType" FROM "ContentIssue" i
        WHERE i.status IN ('open', 'in-progress') AND (
          (i."targetType" = r.type AND i."targetId" = r.id)
          OR (r.type = 'question' AND i."targetType" = 'card' AND i."targetId" = q."cardId")
          OR (r.type = 'card' AND i."targetType" = 'question' AND i."targetId" IN
            (SELECT linked.id FROM "Question" linked WHERE linked."cardId" = c.id))
        )) AS "issueTypes"
    FROM requested r
    LEFT JOIN "Card" c ON r.type = 'card' AND c.id = r.id
    LEFT JOIN "Question" q ON r.type = 'question' AND q.id = r.id
  `);
  return rows.filter(row => row.unavailable || row.issueTypes?.some(withholdsFromServing)).map(row => row.key);
}
