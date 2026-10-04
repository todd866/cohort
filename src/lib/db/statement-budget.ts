/**
 * The reviewed place where a job sets its own database time limits for the
 * work it does inside a transaction.
 *
 * The database role carries (or will carry) a default statement ceiling, so a
 * backend whose client has given up stops instead of scanning on. A job whose
 * statements legitimately run longer, or that wants a tighter bound than the
 * default, says so here rather than depending on whatever the role happens to
 * be set to.
 *
 * Why SET LOCAL, inside the transaction. Pooled connections go through
 * PgBouncer in transaction mode:
 *  - a session-level SET would stay on a server connection that other clients
 *    borrow next;
 *  - a startup parameter (a `statement_timeout` in a pool config) never
 *    reaches the server at all;
 *  - a changed role default reaches only server connections opened after the
 *    change, so warm ones keep the old value.
 * SET LOCAL applies to exactly this transaction on exactly this connection and
 * is reset at COMMIT or ROLLBACK. Zero is refused: a pooled transaction may
 * raise the ceiling, never remove it.
 *
 * A DIRECT single-connection session (a pg.Client on the unpooled endpoint)
 * sets its limits for the whole session instead, as startup options: see
 * `directPgOptions({ serverLimits })` in scripts/lib/pg-direct-config.mjs.
 *
 * The SQL is generated here from validated whole milliseconds, so no caller
 * interpolates a value into SET.
 */

export type LocalLimitSetting =
  | 'statement_timeout'
  | 'lock_timeout'
  | 'idle_in_transaction_session_timeout';

const SETTINGS: readonly LocalLimitSetting[] = [
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
];

/** No transaction in this codebase should hold a connection longer than this. */
export const MAX_LOCAL_LIMIT_MS = 6 * 60 * 60 * 1_000;

/** The client-side transaction timeout outlasts the server budget by this much. */
const CLIENT_MARGIN_MS = 10_000;

export interface LocalLimits {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
}

/** Anything that can run one raw statement inside the open transaction. */
export interface LocalLimitExecutor {
  $executeRawUnsafe(sql: string): PromiseLike<unknown>;
}

export function localLimitSql(setting: LocalLimitSetting, ms: number): string {
  if (!SETTINGS.includes(setting)) {
    throw new TypeError(`Unknown transaction limit setting: ${String(setting)}`);
  }
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_LOCAL_LIMIT_MS) {
    throw new RangeError(
      `${setting} must be a positive whole number of milliseconds up to ${MAX_LOCAL_LIMIT_MS}`,
    );
  }
  return `SET LOCAL ${setting} = '${ms}ms'`;
}

function limitStatements(limits: LocalLimits): string[] {
  const statements: string[] = [];
  if (limits.statementTimeoutMs !== undefined) {
    statements.push(localLimitSql('statement_timeout', limits.statementTimeoutMs));
  }
  if (limits.lockTimeoutMs !== undefined) {
    statements.push(localLimitSql('lock_timeout', limits.lockTimeoutMs));
  }
  if (limits.idleInTransactionSessionTimeoutMs !== undefined) {
    statements.push(localLimitSql(
      'idle_in_transaction_session_timeout',
      limits.idleInTransactionSessionTimeoutMs,
    ));
  }
  return statements;
}

/**
 * Set this transaction's limits. Call it before the work it bounds, inside the
 * same interactive transaction. Every value is validated before anything is sent.
 */
export async function setLocalLimits(tx: LocalLimitExecutor, limits: LocalLimits): Promise<void> {
  for (const sql of limitStatements(limits)) await tx.$executeRawUnsafe(sql);
}

interface TransactionHost<Tx> {
  $transaction<T>(
    work: (tx: Tx) => Promise<T>,
    options: { maxWait: number; timeout: number },
  ): Promise<T>;
}

/**
 * Run `work` in one interactive transaction whose first statement sets the
 * statement budget. For a long statement that does not already run inside a
 * transaction of its own. The client-side transaction timeout is set just
 * above the budget, so the server cancels first and no backend outlives a
 * client that gave up.
 */
export async function withStatementBudget<Tx extends LocalLimitExecutor, T>(
  host: TransactionHost<Tx>,
  budget: LocalLimits & { statementTimeoutMs: number; maxWaitMs?: number },
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const { maxWaitMs = 10_000, ...limits } = budget;
  limitStatements(limits);
  return host.$transaction(async (tx) => {
    await setLocalLimits(tx, limits);
    return work(tx);
  }, { maxWait: maxWaitMs, timeout: budget.statementTimeoutMs + CLIENT_MARGIN_MS });
}

/**
 * Wrap a client so that every interactive transaction it opens starts with the
 * given limits. For a script whose transactions are opened inside shared
 * helpers it does not own (the seed): through the pooler this is the only way
 * a limit reaches all of them. Batch transactions and every other member pass
 * through untouched, bound to the real client.
 */
export function withLocalLimitsOnTransactions<C extends object>(client: C, limits: LocalLimits): C {
  limitStatements(limits);
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (property !== '$transaction') return value.bind(target);
      return (arg: unknown, ...rest: unknown[]) => {
        if (typeof arg !== 'function') return value.call(target, arg, ...rest);
        const work = arg as (tx: LocalLimitExecutor) => Promise<unknown>;
        return value.call(target, async (tx: LocalLimitExecutor) => {
          await setLocalLimits(tx, limits);
          return work(tx);
        }, ...rest);
      };
    },
  });
}
