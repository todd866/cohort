import type { Adapter, AdapterUser } from 'next-auth/adapters';
import { logger } from './logger';

/**
 * Sign-in must survive a deploy that lands before its migration.
 *
 * The Prisma adapter reads and returns the WHOLE `User` row, so the generated
 * client selects every column it knows about. When code that adds `User`
 * columns reaches production before `prisma migrate deploy`, every session
 * lookup fails with P2022 ("column does not exist") and nobody can sign in.
 *
 * This wrapper retries exactly those reads and writes once with an explicit
 * select of the columns that are not new, and only when the error names one
 * of the columns listed in `NEW_USER_COLUMNS`. Any other error is rethrown.
 * The rest of the app treats a missing new column as "feature off" on its own.
 */
export const NEW_USER_COLUMNS: readonly string[] = Object.freeze([
  // 20261118121000_linked_learner_profiles
  'parentUserId',
  'activeProfileUserId',
  'profileSettings',
]);

export function isMissingNewUserColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; message?: unknown; meta?: { column?: unknown } };
  const text = `${typeof record.message === 'string' ? record.message : ''} ${typeof record.meta?.column === 'string' ? record.meta.column : ''}`;
  const missingColumn = record.code === 'P2022' || /column .* does not exist/i.test(text);
  return missingColumn && NEW_USER_COLUMNS.some((column) => text.includes(column));
}

type Select = Record<string, true>;

/** The slice of Prisma the fallback uses. */
export interface LegacyUserDb {
  user: {
    findUnique(args: { where: { id: string } | { email: string }; select: Select }): Promise<unknown>;
    create(args: { data: Record<string, unknown>; select: Select }): Promise<unknown>;
    update(args: { where: { id: string }; data: Record<string, unknown>; select: Select }): Promise<unknown>;
  };
  session: {
    findUnique(args: { where: { sessionToken: string }; include: { user: { select: Select } } }): Promise<unknown>;
  };
  account: {
    findUnique(args: {
      where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
      include: { user: { select: Select } };
    }): Promise<unknown>;
  };
}

function withoutUndefined(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

export function createNewColumnTolerantAdapter(
  base: Adapter,
  db: LegacyUserDb,
  userScalarFields: readonly string[],
): Adapter {
  const legacySelect: Select = Object.fromEntries(
    userScalarFields.filter((field) => !NEW_USER_COLUMNS.includes(field)).map((field) => [field, true as const]),
  );
  async function tolerate<T>(operation: string, primary: () => T | PromiseLike<T>, fallback: () => Promise<T>): Promise<T> {
    try {
      return await primary();
    } catch (error) {
      if (!isMissingNewUserColumn(error)) throw error;
      logger.warn('auth-user-columns-pending-migration', { operation });
      return fallback();
    }
  }
  const adapter: Adapter = { ...base };
  if (base.getUser) {
    const getUser = base.getUser;
    adapter.getUser = (id) => tolerate('getUser', () => getUser(id),
      async () => (await db.user.findUnique({ where: { id }, select: legacySelect })) as AdapterUser | null);
  }
  if (base.getUserByEmail) {
    const getUserByEmail = base.getUserByEmail;
    adapter.getUserByEmail = (email) => tolerate('getUserByEmail', () => getUserByEmail(email),
      async () => (await db.user.findUnique({ where: { email }, select: legacySelect })) as AdapterUser | null);
  }
  if (base.getUserByAccount) {
    const getUserByAccount = base.getUserByAccount;
    adapter.getUserByAccount = (account) => tolerate('getUserByAccount', () => getUserByAccount(account),
      async () => {
        const row = await db.account.findUnique({
          where: { provider_providerAccountId: { provider: account.provider, providerAccountId: account.providerAccountId } },
          include: { user: { select: legacySelect } },
        }) as { user?: AdapterUser } | null;
        return row?.user ?? null;
      });
  }
  if (base.getSessionAndUser) {
    const getSessionAndUser = base.getSessionAndUser;
    adapter.getSessionAndUser = (sessionToken) => tolerate('getSessionAndUser', () => getSessionAndUser(sessionToken),
      async () => {
        const row = await db.session.findUnique({ where: { sessionToken }, include: { user: { select: legacySelect } } }) as
          ({ user: AdapterUser } & Record<string, unknown>) | null;
        if (!row) return null;
        const { user, ...session } = row;
        return { user, session: session as never };
      });
  }
  if (base.createUser) {
    const createUser = base.createUser;
    adapter.createUser = (user) => tolerate('createUser', () => createUser(user),
      async () => {
        const { id: _id, ...data } = user as AdapterUser & Record<string, unknown>;
        void _id;
        return (await db.user.create({ data: withoutUndefined(data), select: legacySelect })) as AdapterUser;
      });
  }
  if (base.updateUser) {
    const updateUser = base.updateUser;
    adapter.updateUser = (user) => tolerate('updateUser', () => updateUser(user),
      async () => {
        const { id, ...data } = user as AdapterUser & Record<string, unknown>;
        return (await db.user.update({ where: { id }, data: withoutUndefined(data), select: legacySelect })) as AdapterUser;
      });
  }
  return adapter;
}
