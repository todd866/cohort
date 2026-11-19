// Guard: `server-only` throws outside Next.js (for example in Vitest and scripts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
try { require('server-only'); } catch {}

// The capability shared by the Card repository and the global Prisma extension. A bare `ownerUserId` filter
// is not proof of authorization: only the repository's own ownership predicate, conjoined at the top level of a
// where object, opts a read out of the shared-catalog default.
//
// Recognition is by exact shape, not object identity. Prisma hands a query extension a COPY of the arguments,
// so the earlier identity registry (a WeakMap of where objects) never matched in a real client: every
// owner-private read fell back to `ownerUserId = null`, and a learner's own cards could not be loaded at all.
// Unit tests called the extension with the original object and passed. The shape is safe to recognise because
// it is the whole boundary: shared cards, or cards of exactly one owner in that owner's active epoch and live
// deck. A where object carrying it under a top-level AND cannot return anything else, whoever built it.

/** Shared catalog only. */
export const SHARED_CATALOG_PREDICATE = Object.freeze({ ownerUserId: null });

/** Shared cards, plus this owner's private cards in their active epoch and live deck. The one definition. */
export function ownerPrivateOrSharedPredicate(ownerUserId: string) {
  return {
    OR: [
      { ownerUserId: null },
      {
        ownerUserId,
        importEpoch: {
          is: {
            status: 'active' as const,
            ownerUserId,
            activeForDeck: { is: { ownerUserId, deletedAt: null } },
          },
        },
      },
    ],
  };
}

/**
 * Deep equality over plain data only. An object with any other prototype, an accessor, a function or a `toJSON`
 * is never equal to the predicate, so nothing can describe itself as the predicate while filtering differently.
 */
function plainEqual(value: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return value === expected;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(expected)) {
    return Array.isArray(value) && value.length === expected.length && expected.every((item, i) => plainEqual(value[i], item));
  }
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value) || (proto !== Object.prototype && proto !== null)) return false;
  const keys = Reflect.ownKeys(value);
  const expectedKeys = Object.keys(expected);
  if (keys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => {
    const own = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(own && 'value' in own && own.enumerable)
      && plainEqual(own!.value, (expected as Record<string, unknown>)[key]);
  });
}

function isOwnershipPredicate(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (plainEqual(value, SHARED_CATALOG_PREDICATE)) return true;
  const branches = Object.getOwnPropertyDescriptor(value, 'OR')?.value as unknown;
  const second = Array.isArray(branches) && branches[1] && typeof branches[1] === 'object'
    ? Object.getOwnPropertyDescriptor(branches[1], 'ownerUserId')?.value as unknown : undefined;
  return typeof second === 'string' && second.length > 0 && second.trim() === second
    && plainEqual(value, ownerPrivateOrSharedPredicate(second));
}

/** Kept as the repository's single construction point; recognition no longer depends on it. */
export function registerRepositoryScopedCardWhere<T extends object>(where: T, _requiredOwnershipPredicate: object): T {
  return where;
}

export function isRepositoryScopedCardWhere(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const and = (value as { AND?: unknown }).AND;
  return Array.isArray(and) && and.some(isOwnershipPredicate);
}
