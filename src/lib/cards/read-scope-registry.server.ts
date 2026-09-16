// Guard: `server-only` throws outside Next.js (for example in Vitest and scripts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
try { require('server-only'); } catch {}

// This registry is the capability shared by the Card repository and the
// global Prisma extension. A structural `ownerUserId` predicate is not proof
// of authorization: only a where object constructed by the repository may
// opt out of the global shared-catalog default.
const repositoryScopedCardWheres = new WeakMap<object, object>();

export function registerRepositoryScopedCardWhere<T extends object>(
  where: T,
  requiredOwnershipPredicate: object,
): T {
  repositoryScopedCardWheres.set(where, requiredOwnershipPredicate);
  return where;
}

export function isRepositoryScopedCardWhere(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const requiredOwnershipPredicate = repositoryScopedCardWheres.get(value);
  if (!requiredOwnershipPredicate) return false;
  const and = (value as { AND?: unknown }).AND;
  return Array.isArray(and) && and.includes(requiredOwnershipPredicate);
}
