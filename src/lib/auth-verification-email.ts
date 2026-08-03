export interface VerificationEmailEnvironment {
  NODE_ENV?: string;
  NEXTAUTH_URL?: string;
  AUTH_URL?: string;
  AUTH_TRUST_MD3_COHORT_HOSTS?: string;
}

export interface MutableAuthEnvironment extends VerificationEmailEnvironment {
  [key: string]: string | undefined;
}

export interface VerificationEmailContext {
  verifyUrl: string;
  productName: 'Cohort' | 'MD3 Study';
  actionLabel: 'Sign in to Cohort' | 'Sign in to MD3';
  subject: 'Sign in to Cohort' | 'Sign in to MD3 Study';
}

const FIRST_PARTY_HOSTS = new Set([
  'md3.info',
  'www.md3.info',
  'cohort.md',
  'www.cohort.md',
]);

function normalizedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '[::1]';
}

function configuredOrigins(env: VerificationEmailEnvironment): Set<string> {
  return new Set(
    [env.NEXTAUTH_URL, env.AUTH_URL]
      .map(normalizedOrigin)
      .filter((origin): origin is string => origin !== null),
  );
}

function isFirstPartyConfiguredUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return FIRST_PARTY_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function trustsCanonicalDualHosts(env: VerificationEmailEnvironment): boolean {
  return env.AUTH_TRUST_MD3_COHORT_HOSTS?.trim().toLowerCase() === 'true';
}

/**
 * Auth.js v5 replaces every incoming request origin with AUTH_URL or
 * NEXTAUTH_URL when either is present. That is incompatible with the MD3 +
 * Cohort production deployment, where both hosts must retain their own OAuth
 * callbacks, email links, redirects, and host-only cookies. Remove a stale
 * first-party canonical URL before NextAuth initializes and rely on trustHost.
 * Custom single-host FOSS origins are intentionally preserved.
 */
export function prepareDualHostAuthEnvironment(
  env: MutableAuthEnvironment,
): Array<'AUTH_URL' | 'NEXTAUTH_URL'> {
  if (
    env.NODE_ENV !== 'production'
    || !trustsCanonicalDualHosts(env)
    || !isFirstPartyConfiguredUrl(env.AUTH_URL ?? env.NEXTAUTH_URL)
  ) {
    return [];
  }

  const cleared: Array<'AUTH_URL' | 'NEXTAUTH_URL'> = [];
  for (const key of ['AUTH_URL', 'NEXTAUTH_URL'] as const) {
    if (env[key] !== undefined) {
      delete env[key];
      cleared.push(key);
    }
  }
  return cleared;
}

/**
 * Resolve an application URL to an origin that is safe to place in email or a
 * redirect. Production accepts only the two first-party products or an
 * explicitly configured HTTPS origin; loopback is development-only.
 */
export function resolveTrustedAppOrigin(
  value: string,
  env: VerificationEmailEnvironment = process.env,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Refusing an invalid application URL');
  }

  const configured = configuredOrigins(env);
  const isFirstParty = trustsCanonicalDualHosts(env)
    && url.protocol === 'https:'
    && FIRST_PARTY_HOSTS.has(url.hostname.toLowerCase());
  const isConfigured = configured.has(url.origin)
    && (url.protocol === 'https:' || env.NODE_ENV !== 'production');
  const isLocalDevelopment = env.NODE_ENV !== 'production'
    && (url.protocol === 'http:' || url.protocol === 'https:')
    && isLoopback(url.hostname.toLowerCase());

  if (
    url.username
    || url.password
    || (!isFirstParty && !isConfigured && !isLocalDevelopment)
  ) {
    throw new Error('Refusing an untrusted application origin');
  }

  return url.origin;
}

/**
 * Build the intermediate verification page from Auth.js's signed callback URL.
 *
 * One deployment serves both md3.info and cohort.md, so a single canonical env
 * URL cannot safely choose the wrapper host. The callback origin is authoritative
 * only after this explicit first-party/configured-origin check; arbitrary Host
 * headers must never become links in authentication email.
 */
export function buildVerificationEmailContext(
  callbackUrl: string,
  env: VerificationEmailEnvironment = process.env,
): VerificationEmailContext {
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw new Error('Refusing verification email for an invalid callback URL');
  }

  const isAuthCallback = callback.pathname.startsWith('/api/auth/callback/');

  let trustedOrigin: string;
  try {
    trustedOrigin = resolveTrustedAppOrigin(callback.toString(), env);
  } catch {
    throw new Error('Refusing verification email for an untrusted callback URL');
  }
  if (!isAuthCallback) {
    throw new Error('Refusing verification email for an untrusted callback URL');
  }

  const isCohort = callback.hostname.toLowerCase().replace(/^www\./, '') === 'cohort.md';
  const productName = isCohort ? 'Cohort' : 'MD3 Study';
  const actionLabel = isCohort ? 'Sign in to Cohort' : 'Sign in to MD3';
  const verify = new URL('/auth/verify-email', trustedOrigin);
  verify.searchParams.set('callback', callback.toString());

  return {
    verifyUrl: verify.toString(),
    productName,
    actionLabel,
    subject: `Sign in to ${productName}`,
  };
}
