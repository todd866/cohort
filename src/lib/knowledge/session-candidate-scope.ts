/**
 * Shared scheduler candidate scope for session rotation vs item rotation.
 *
 * Primary rotation items always match their home partition. A caller may also
 * supply rotations that the current user is entitled to use as cross-source
 * material. By default those items only surface when their moduleNodes include
 * the session target (adjacent). Dessert explore mode may also admit entitled
 * source items without target mapping.
 *
 * Keep the Prisma where-fragment and SQL join predicate in this module so both
 * bulk-candidates (Seam 1) and manifold/scoring (Seam 2) stay equivalent.
 *
 * @see docs/designs/2026-05-09-rotation-vs-modulenodes.md
 * @see docs/designs/2026-08-09-cah-dessert-mix.md
 */

import { Prisma } from '@prisma/client';

export type CrossSourceMappingMode = 'adjacent' | 'open';

/** Pure eligibility check — table-driven tests assert Prisma/SQL parity via this. */
export function isSessionCandidateItem(
  itemRotation: string,
  moduleNodes: readonly string[],
  sessionRotation: string,
  allowedCrossSourceRotations: readonly string[] = [],
  mappingMode: CrossSourceMappingMode = 'adjacent',
): boolean {
  if (itemRotation === sessionRotation) return true;
  if (!allowedCrossSourceRotations.includes(itemRotation)) {
    return false;
  }
  if (mappingMode === 'open') return true;
  return moduleNodes.includes(sessionRotation);
}

/**
 * Prisma where fragment for Card and Question candidate queries.
 *
 * Structurally typed rather than annotated `Prisma.CardWhereInput`, because
 * Prisma's WhereInput types are branded per model — a CardWhereInput is not
 * assignable to a QuestionWhereInput even when the shape is identical. The
 * members below only touch `rotation` and `moduleNodes`, which both models have.
 *
 * NOT usable for Video: that model has no `moduleNodes` column (and a nullable
 * `rotation`), so a video cannot declare cross-rotation membership and its query
 * must keep the strict equality filter.
 */
export interface SessionCandidateScopeWhere {
  OR: Array<
    | { rotation: string }
    | { rotation: { in: string[] }; moduleNodes: { has: string } }
    | { rotation: { in: string[] } }
  >;
}

export function sessionCandidateItemWhere(
  sessionRotation: string,
  allowedCrossSourceRotations: readonly string[] = [],
  mappingMode: CrossSourceMappingMode = 'adjacent',
): SessionCandidateScopeWhere {
  if (allowedCrossSourceRotations.length === 0) {
    return { OR: [{ rotation: sessionRotation }] };
  }

  if (mappingMode === 'open') {
    return {
      OR: [
        { rotation: sessionRotation },
        { rotation: { in: [...allowedCrossSourceRotations] } },
      ],
    };
  }

  return {
    OR: [
      { rotation: sessionRotation },
      {
        rotation: { in: [...allowedCrossSourceRotations] },
        moduleNodes: { has: sessionRotation },
      },
    ],
  };
}

/**
 * SQL predicate for parent-table JOINs in pgvector scoring queries.
 * Use as `ON parent.pk = ie.id AND (${sessionCandidateItemJoinSql('p', rotation)})`.
 */
export function sessionCandidateItemJoinSql(
  tableAlias: string,
  sessionRotation: string,
  allowedCrossSourceRotations: readonly string[] = [],
  mappingMode: CrossSourceMappingMode = 'adjacent',
): Prisma.Sql {
  const alias = Prisma.raw(tableAlias);

  if (allowedCrossSourceRotations.length === 0) {
    return Prisma.sql`${alias}.rotation = ${sessionRotation}`;
  }

  const crossSourceList = Prisma.join(
    allowedCrossSourceRotations.map((id) => Prisma.sql`${id}`),
  );

  if (mappingMode === 'open') {
    return Prisma.sql`(
      ${alias}.rotation = ${sessionRotation}
      OR ${alias}.rotation IN (${crossSourceList})
    )`;
  }

  return Prisma.sql`(
    ${alias}.rotation = ${sessionRotation}
    OR (
      ${alias}.rotation IN (${crossSourceList})
      AND ${sessionRotation} = ANY(${alias}."moduleNodes")
    )
  )`;
}
