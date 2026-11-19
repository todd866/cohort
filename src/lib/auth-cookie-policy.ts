/** Public authentication retains secure production cookies without local-demo overrides. */
export function authCookieConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const productionCookies = env.NODE_ENV === 'production';
  return {
    sessionToken: { name: productionCookies ? '__Secure-next-auth.session-token' : 'next-auth.session-token' },
    callbackUrl: { name: productionCookies ? '__Secure-next-auth.callback-url' : 'next-auth.callback-url' },
    csrfToken: { name: productionCookies ? '__Host-next-auth.csrf-token' : 'next-auth.csrf-token' },
  };
}
