// Guard: `server-only` throws outside Next.js (for example in Vitest and scripts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
try { require('server-only'); } catch {}

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { registerRepositoryScopedCardWhere } from './read-scope-registry.server';

const CARD_READ_SCOPE = Symbol('md3.card-read-scope');

export const CARD_MAINTENANCE_PURPOSES = [
  'content-quality',
  'embedding',
  'figures',
  'rights-review',
  'similarity',
  'statistics',
  'sync-export',
] as const;

export type CardMaintenancePurpose = typeof CARD_MAINTENANCE_PURPOSES[number];

type CardReadScopeBase = Readonly<{
  [CARD_READ_SCOPE]: true;
  purpose: 'product' | CardMaintenancePurpose;
}>;

export type SharedCatalogCardReadScope = CardReadScopeBase & Readonly<{
  audience: 'shared-catalog';
}>;

export type OwnerCardReadScope = CardReadScopeBase & Readonly<{
  audience: 'owner-private-or-shared';
  ownerUserId: string;
}>;

export type CardReadScope = SharedCatalogCardReadScope | OwnerCardReadScope;

function sharedScope(purpose: CardReadScopeBase['purpose']): SharedCatalogCardReadScope {
  return Object.freeze({
    [CARD_READ_SCOPE]: true as const,
    audience: 'shared-catalog' as const,
    purpose,
  });
}

function ownerScope(
  ownerUserId: string,
  purpose: CardReadScopeBase['purpose'],
): OwnerCardReadScope {
  if (!ownerUserId || ownerUserId.trim() !== ownerUserId) {
    throw new TypeError('A Card owner scope requires a non-empty, canonical user id');
  }
  return Object.freeze({
    [CARD_READ_SCOPE]: true as const,
    audience: 'owner-private-or-shared' as const,
    ownerUserId,
    purpose,
  });
}

/** Public catalog reads. Owner-private Cards are always excluded. */
export const SHARED_CATALOG_CARD_SCOPE = sharedScope('product');

/** A signed-in user's shared catalog plus only Cards owned by that user. */
export function ownerPrivateOrSharedCardScope(ownerUserId: string): OwnerCardReadScope {
  return ownerScope(ownerUserId, 'product');
}

/**
 * Maintenance never grants cross-tenant access. Callers must choose either the
 * shared catalog or one concrete owner and state why the read is needed.
 */
export function sharedCardMaintenanceScope(
  purpose: CardMaintenancePurpose,
): SharedCatalogCardReadScope {
  return sharedScope(purpose);
}

export function ownerCardMaintenanceScope(
  purpose: CardMaintenancePurpose,
  ownerUserId: string,
): OwnerCardReadScope {
  return ownerScope(ownerUserId, purpose);
}

function assertScope(scope: CardReadScope): void {
  if (!scope || scope[CARD_READ_SCOPE] !== true) {
    throw new TypeError('Card reads require a scope created by the Card read repository');
  }
  if (scope.audience === 'owner-private-or-shared') {
    if (!scope.ownerUserId || scope.ownerUserId.trim() !== scope.ownerUserId) {
      throw new TypeError('Owner-private Card reads require a canonical user id');
    }
  }
}

function ownershipWhere(scope: CardReadScope): Prisma.CardWhereInput {
  assertScope(scope);
  return scope.audience === 'shared-catalog'
    ? { ownerUserId: null }
    : {
        OR: [
          { ownerUserId: null },
          {
            ownerUserId: scope.ownerUserId,
            importEpoch: {
              is: {
                status: 'active',
                ownerUserId: scope.ownerUserId,
                activeForDeck: {
                  is: {
                    ownerUserId: scope.ownerUserId,
                    deletedAt: null,
                  },
                },
              },
            },
          },
        ],
      };
}

function appendAnd<T extends { AND?: unknown }>(where: T, required: unknown): T {
  const currentAnd = Array.isArray(where.AND)
    ? where.AND
    : where.AND == null
      ? []
      : [where.AND];
  return {
    ...where,
    AND: [...currentAnd, required],
  };
}

function deepFreezePredicate<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezePredicate(child);
  return Object.freeze(value);
}

/**
 * Build a composable Card predicate. This is also the only supported way to
 * scope nested Card relations and reviewed raw-query adapters.
 */
export function scopedCardWhere(
  scope: CardReadScope,
  where: Prisma.CardWhereInput = {},
): Prisma.CardWhereInput {
  const requiredOwnershipPredicate = deepFreezePredicate(ownershipWhere(scope));
  return registerRepositoryScopedCardWhere(
    appendAnd(where, requiredOwnershipPredicate),
    requiredOwnershipPredicate,
  );
}

/** Scope CardProgress relation reads without exposing another owner's Card. */
export function scopedCardProgressWhere(
  scope: CardReadScope,
  where: Prisma.CardProgressWhereInput = {},
  cardWhere: Prisma.CardWhereInput = {},
): Prisma.CardProgressWhereInput {
  return appendAnd(where, { card: { is: scopedCardWhere(scope, cardWhere) } });
}

/**
 * Ownership predicate for reviewed raw-SQL adapters. The alias is a closed
 * union so no caller-controlled SQL identifier can reach Prisma.raw().
 */
export function scopedCardSqlPredicate(
  scope: CardReadScope,
  alias: 'c' | 'card' | 'p' | 'source_card',
): Prisma.Sql {
  assertScope(scope);
  const table = Prisma.raw(alias);
  if (scope.audience === 'shared-catalog') {
    return Prisma.sql`${table}."ownerUserId" IS NULL`;
  }
  return Prisma.sql`(
    ${table}."ownerUserId" IS NULL
    OR (
      ${table}."ownerUserId" = ${scope.ownerUserId}
      AND EXISTS (
        SELECT 1
        FROM "ImportEpoch" scoped_epoch
        JOIN "StudyDeck" scoped_deck
          ON scoped_deck.id = scoped_epoch."studyDeckId"
          AND scoped_deck."ownerUserId" = scoped_epoch."ownerUserId"
        WHERE scoped_epoch.id = ${table}."importEpochId"
          AND scoped_epoch."studyDeckId" = ${table}."studyDeckId"
          AND scoped_epoch."ownerUserId" = ${scope.ownerUserId}
          AND scoped_epoch.status = 'active'::"ImportEpochStatus"
          AND scoped_deck."activeEpochId" = scoped_epoch.id
          AND scoped_deck."deletedAt" IS NULL
      )
    )
  )`;
}

// Holding the delegate under a repository-local name is deliberate: runtime
// callers cannot import it, and the access-boundary ratchet continues to flag
// every direct `prisma.card.*` call outside this module.
const model = prisma.card as unknown as PrismaClient['card'];
const progressModel = prisma.cardProgress as unknown as PrismaClient['cardProgress'];
const learningEventModel = prisma.learningEvent as unknown as PrismaClient['learningEvent'];

type CardFindManyModel = Readonly<{
  findMany(args: Prisma.CardFindManyArgs): Promise<unknown>;
}>;

type LearningEventFindFirstModel = Readonly<{
  findFirst(args: Prisma.LearningEventFindFirstArgs): Promise<unknown>;
}>;

export async function findManyCards<T extends Prisma.CardFindManyArgs>(
  scope: CardReadScope,
  args: T,
  card: CardFindManyModel = model,
): Promise<Array<Prisma.CardGetPayload<T>>> {
  const scopedArgs = {
    ...args,
    where: scopedCardWhere(scope, args.where),
  } as Prisma.CardFindManyArgs;
  return card.findMany(scopedArgs) as unknown as Promise<Array<Prisma.CardGetPayload<T>>>;
}

export async function findFirstCard<T extends Prisma.CardFindFirstArgs>(
  scope: CardReadScope,
  args: T,
): Promise<Prisma.CardGetPayload<T> | null> {
  const scopedArgs = {
    ...args,
    where: scopedCardWhere(scope, args.where),
  } as Prisma.CardFindFirstArgs;
  return model.findFirst(scopedArgs) as unknown as Promise<Prisma.CardGetPayload<T> | null>;
}

export async function findFirstCardOrThrow<T extends Prisma.CardFindFirstOrThrowArgs>(
  scope: CardReadScope,
  args: T,
): Promise<Prisma.CardGetPayload<T>> {
  const scopedArgs = {
    ...args,
    where: scopedCardWhere(scope, args.where),
  } as Prisma.CardFindFirstOrThrowArgs;
  return model.findFirstOrThrow(scopedArgs) as unknown as Promise<Prisma.CardGetPayload<T>>;
}

export async function findUniqueCard<T extends Prisma.CardFindUniqueArgs>(
  scope: CardReadScope,
  args: T,
): Promise<Prisma.CardGetPayload<T> | null> {
  const scopedArgs = {
    ...args,
    where: scopedCardWhere(scope, args.where) as Prisma.CardWhereUniqueInput,
  } as Prisma.CardFindUniqueArgs;
  return model.findUnique(scopedArgs) as unknown as Promise<Prisma.CardGetPayload<T> | null>;
}

export async function findUniqueCardOrThrow<T extends Prisma.CardFindUniqueOrThrowArgs>(
  scope: CardReadScope,
  args: T,
): Promise<Prisma.CardGetPayload<T>> {
  const scopedArgs = {
    ...args,
    where: scopedCardWhere(scope, args.where) as Prisma.CardWhereUniqueInput,
  } as Prisma.CardFindUniqueOrThrowArgs;
  return model.findUniqueOrThrow(scopedArgs) as unknown as Promise<Prisma.CardGetPayload<T>>;
}

export async function countCards(
  scope: CardReadScope,
  args: Prisma.CardCountArgs = {},
): Promise<number> {
  return model.count({
    ...args,
    where: scopedCardWhere(scope, args.where),
  });
}

/**
 * Read progress together with Card metadata through the same owner boundary.
 * Keeping the relation read here prevents a caller from supplying a scoped
 * Card predicate but forgetting to attach it to CardProgress.
 */
export async function findManyCardProgress<T extends Prisma.CardProgressFindManyArgs>(
  scope: CardReadScope,
  args: T,
  cardWhere: Prisma.CardWhereInput = {},
  progress: PrismaClient['cardProgress'] = progressModel,
): Promise<Array<Prisma.CardProgressGetPayload<T>>> {
  const scopedArgs = {
    ...args,
    where: scopedCardProgressWhere(scope, args.where, cardWhere),
  } as Prisma.CardProgressFindManyArgs;
  return progress.findMany(scopedArgs) as unknown as Promise<
    Array<Prisma.CardProgressGetPayload<T>>
  >;
}

export async function findFirstCardProgress<T extends Prisma.CardProgressFindFirstArgs>(
  scope: CardReadScope,
  args: T,
  cardWhere: Prisma.CardWhereInput = {},
  progress: PrismaClient['cardProgress'] = progressModel,
): Promise<Prisma.CardProgressGetPayload<T> | null> {
  const scopedArgs = {
    ...args,
    where: scopedCardProgressWhere(scope, args.where, cardWhere),
  } as Prisma.CardProgressFindFirstArgs;
  return progress.findFirst(scopedArgs) as unknown as Promise<
    Prisma.CardProgressGetPayload<T> | null
  >;
}

/**
 * Read a LearningEvent whose polymorphic source is one already-authorized Card.
 * The owner identity and source discriminator are repository-owned predicates;
 * callers can only narrow the event query further.
 */
export async function findFirstCardLearningEvent<
  T extends Prisma.LearningEventFindFirstArgs,
>(
  scope: OwnerCardReadScope,
  sourceId: string,
  args: T,
  learningEvent: LearningEventFindFirstModel = learningEventModel,
): Promise<Prisma.LearningEventGetPayload<T> | null> {
  assertScope(scope);
  if (scope.audience !== 'owner-private-or-shared') {
    throw new TypeError('Card learning-event reads require an owner scope');
  }
  if (!sourceId || sourceId.trim() !== sourceId) {
    throw new TypeError('A Card learning-event read requires a canonical source id');
  }
  const scopedArgs = {
    ...args,
    where: appendAnd(args.where ?? {}, {
      userId: scope.ownerUserId,
      sourceType: 'card',
      sourceId,
    }),
  } as Prisma.LearningEventFindFirstArgs;
  return learningEvent.findFirst(scopedArgs) as unknown as Promise<
    Prisma.LearningEventGetPayload<T> | null
  >;
}

/** Narrow groupings used by profile statistics; arbitrary groupBy stays closed. */
export async function groupCardsByRotation(
  scope: CardReadScope,
  where: Prisma.CardWhereInput = {},
): Promise<Array<{ rotation: string; _count: number }>> {
  const groupByRotation = model.groupBy as unknown as (args: {
    by: ['rotation'];
    where: Prisma.CardWhereInput;
    _count: true;
  }) => Promise<Array<{ rotation: string; _count: number }>>;
  return groupByRotation({
    by: ['rotation'],
    where: scopedCardWhere(scope, where),
    _count: true,
  });
}

export async function groupCardsByWeek(
  scope: CardReadScope,
  where: Prisma.CardWhereInput = {},
): Promise<Array<{ week: number | null; _count: number }>> {
  const groupByWeek = model.groupBy as unknown as (args: {
    by: ['week'];
    where: Prisma.CardWhereInput;
    _count: true;
  }) => Promise<Array<{ week: number | null; _count: number }>>;
  return groupByWeek({
    by: ['week'],
    where: scopedCardWhere(scope, where),
    _count: true,
  });
}
