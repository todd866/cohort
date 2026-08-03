export type DatabaseTargetName = 'local-mirror' | 'configured-database';

export interface DatabaseTargetEnvironment {
  [key: string]: string | undefined;
  DATABASE_URL?: string;
  DATABASE_URL_LOCAL?: string;
}

export interface ResolvedDatabaseTarget {
  name: DatabaseTargetName;
  connectionString: string | undefined;
}

/**
 * Resolve the one database target used by runtime and release tooling.
 *
 * A non-empty local override wins. An unset or explicitly empty override uses
 * the configured database. Callers may log `name`; they must never log the
 * credential-bearing connection string.
 */
export function resolveDatabaseTarget(
  env: DatabaseTargetEnvironment = process.env,
): ResolvedDatabaseTarget {
  if (env.DATABASE_URL_LOCAL) {
    return {
      name: 'local-mirror',
      connectionString: env.DATABASE_URL_LOCAL,
    };
  }
  return {
    name: 'configured-database',
    connectionString: env.DATABASE_URL,
  };
}
