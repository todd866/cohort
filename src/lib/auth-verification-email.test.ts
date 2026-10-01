import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildVerificationEmailContext,
  prepareDualHostAuthEnvironment,
  resolveTrustedAppOrigin,
} from './auth-verification-email';

function callback(origin: string): string {
  return `${origin}/api/auth/callback/email?token=opaque&email=learner%40example.com`;
}

const canonicalDualHostProduction = {
  NODE_ENV: 'production',
  AUTH_TRUST_MD3_COHORT_HOSTS: 'true',
} as const;

describe('buildVerificationEmailContext', () => {
  it('keeps MD3 verification on the MD3 origin', () => {
    const original = callback('https://md3.info');
    const context = buildVerificationEmailContext(original, canonicalDualHostProduction);
    const wrapper = new URL(context.verifyUrl);

    expect(wrapper.origin).toBe('https://md3.info');
    expect(wrapper.pathname).toBe('/auth/verify-email');
    expect(wrapper.searchParams.get('callback')).toBe(original);
    expect(context).toMatchObject({
      productName: 'MD3 Study',
      actionLabel: 'Sign in to MD3',
      subject: 'Sign in to MD3 Study',
    });
  });

  it('keeps Cohort verification on the Cohort origin with Cohort copy', () => {
    const original = callback('https://cohort.md');
    const context = buildVerificationEmailContext(original, canonicalDualHostProduction);
    const wrapper = new URL(context.verifyUrl);

    expect(wrapper.origin).toBe('https://cohort.md');
    expect(wrapper.searchParams.get('callback')).toBe(original);
    expect(context).toMatchObject({
      productName: 'Cohort',
      actionLabel: 'Sign in to Cohort',
      subject: 'Sign in to Cohort',
    });
  });

  it('allows an explicitly configured HTTPS origin for a FOSS deployment', () => {
    const context = buildVerificationEmailContext(callback('https://learn.example.org'), {
      NODE_ENV: 'production',
      AUTH_URL: 'https://learn.example.org',
    });

    expect(new URL(context.verifyUrl).origin).toBe('https://learn.example.org');
    expect(context.productName).toBe('MD3 Study');
  });

  it('allows loopback only outside production', () => {
    expect(() => buildVerificationEmailContext(callback('http://localhost:3000'), {
      NODE_ENV: 'development',
    })).not.toThrow();
    expect(() => buildVerificationEmailContext(callback('http://localhost:3000'), {
      NODE_ENV: 'production',
    })).toThrow(/untrusted callback/i);
  });

  it('does not trust canonical product hosts in an unconfigured fork', () => {
    expect(() => buildVerificationEmailContext(callback('https://md3.info'), {
      NODE_ENV: 'production',
    })).toThrow(/untrusted callback/i);
    expect(() => buildVerificationEmailContext(callback('https://cohort.md'), {
      NODE_ENV: 'production',
    })).toThrow(/untrusted callback/i);
  });

  it.each([
    'https://cohort.md.evil.example/api/auth/callback/email?token=opaque',
    'https://evil.example/api/auth/callback/email?token=opaque',
    'https://user:password@md3.info/api/auth/callback/email?token=opaque',
    'https://md3.info/not-an-auth-callback?token=opaque',
    'javascript:alert(1)',
  ])('rejects an untrusted or malformed callback: %s', (url) => {
    expect(() => buildVerificationEmailContext(url, {
      NODE_ENV: 'production',
      NEXTAUTH_URL: 'https://md3.info',
    })).toThrow(/refusing verification email/i);
  });
});

describe('resolveTrustedAppOrigin', () => {
  it.each([
    ['https://md3.info/api/user/email-aliases', 'https://md3.info'],
    ['https://www.cohort.md/api/user/email-aliases', 'https://www.cohort.md'],
  ])('accepts an exact first-party request origin: %s', (value, expected) => {
    expect(resolveTrustedAppOrigin(value, canonicalDualHostProduction)).toBe(expected);
  });

  it('accepts an explicitly configured HTTPS operator origin', () => {
    expect(resolveTrustedAppOrigin('https://learn.example.org/profile', {
      NODE_ENV: 'production',
      AUTH_URL: 'https://learn.example.org',
    })).toBe('https://learn.example.org');
  });

  it('rejects an unconfigured canonical host in production', () => {
    expect(() => resolveTrustedAppOrigin('https://md3.info/profile', {
      NODE_ENV: 'production',
    })).toThrow(/refusing/i);
  });

  it.each([
    'https://cohort.md.evil.example/api/user/email-aliases',
    'https://user:password@cohort.md/api/user/email-aliases',
    'http://cohort.md/api/user/email-aliases',
  ])('rejects a hostile or insecure production origin: %s', (value) => {
    expect(() => resolveTrustedAppOrigin(value, { NODE_ENV: 'production' }))
      .toThrow(/refusing/i);
  });
});

describe('prepareDualHostAuthEnvironment', () => {
  it('removes a fixed first-party production origin before Auth.js initializes', () => {
    const env = {
      NODE_ENV: 'production',
      AUTH_TRUST_MD3_COHORT_HOSTS: 'true',
      AUTH_URL: 'https://md3.info',
      NEXTAUTH_URL: 'https://cohort.md/api/auth',
    };

    expect(prepareDualHostAuthEnvironment(env)).toEqual(['AUTH_URL', 'NEXTAUTH_URL']);
    expect(env).not.toHaveProperty('AUTH_URL');
    expect(env).not.toHaveProperty('NEXTAUTH_URL');
  });

  it('does not rewrite a canonical URL unless dual-host trust is explicit', () => {
    const env = {
      NODE_ENV: 'production',
      AUTH_URL: 'https://md3.info',
    };

    expect(prepareDualHostAuthEnvironment(env)).toEqual([]);
    expect(env.AUTH_URL).toBe('https://md3.info');
  });

  it('preserves an explicitly configured custom single-host FOSS origin', () => {
    const env = {
      NODE_ENV: 'production',
      AUTH_URL: 'https://learn.example.org',
    };

    expect(prepareDualHostAuthEnvironment(env)).toEqual([]);
    expect(env.AUTH_URL).toBe('https://learn.example.org');
  });

  it('honours Auth.js precedence when a custom AUTH_URL shadows a stale fallback', () => {
    const env = {
      NODE_ENV: 'production',
      AUTH_URL: 'https://learn.example.org',
      NEXTAUTH_URL: 'https://md3.info',
    };

    expect(prepareDualHostAuthEnvironment(env)).toEqual([]);
    expect(env).toMatchObject({
      AUTH_URL: 'https://learn.example.org',
      NEXTAUTH_URL: 'https://md3.info',
    });
  });

  it('does not rewrite local development configuration', () => {
    const env = {
      NODE_ENV: 'development',
      NEXTAUTH_URL: 'http://localhost:3000',
    };

    expect(prepareDualHostAuthEnvironment(env)).toEqual([]);
    expect(env.NEXTAUTH_URL).toBe('http://localhost:3000');
  });

  it('does not mistake a hostile suffix host for a first-party deployment', () => {
    const env = {
      NODE_ENV: 'production',
      AUTH_URL: 'https://cohort.md.evil.example',
    };

    expect(prepareDualHostAuthEnvironment(env)).toEqual([]);
    expect(env.AUTH_URL).toBe('https://cohort.md.evil.example');
  });

  it('runs before the pinned Auth.js request-origin override can initialize', () => {
    const root = process.cwd();
    const nextAuthEnv = fs.readFileSync(
      path.join(root, 'node_modules/next-auth/lib/env.js'),
      'utf8',
    );
    const authSource = fs.readFileSync(path.join(root, 'src/lib/auth.ts'), 'utf8');
    const preparation = authSource.indexOf(
      'const clearedAuthOrigins = prepareDualHostAuthEnvironment(process.env);',
    );
    const initialization = authSource.indexOf('NextAuth({');

    expect(nextAuthEnv).toContain('process.env.AUTH_URL ?? process.env.NEXTAUTH_URL');
    expect(preparation).toBeGreaterThanOrEqual(0);
    expect(initialization).toBeGreaterThan(preparation);
  });

  it('does not place a verification recipient or token in failure logs', () => {
    const authSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/auth.ts'), 'utf8');
    const failureLog = authSource.match(
      /logger\.error\('Failed to send verification email', \{([^}]*)\}\)/s,
    );

    expect(failureLog).not.toBeNull();
    expect(failureLog?.[1]).not.toMatch(/\b(?:email|identifier|token|url)\b/i);
    expect(authSource).not.toContain('result.error.message');
  });
});
