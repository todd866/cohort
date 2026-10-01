import { describe, it, expect, beforeAll } from 'vitest';

// Dynamic import avoids esbuild's static dep-scanner, which can't resolve a
// sibling .mjs from a .ts test. The runner (prisma-with-env.mjs) loads this
// same module under plain node, so .mjs is required for runtime.
//
// NB: fixture URLs deliberately omit `user:pass@` credentials so the
// pre-commit secret scan doesn't flag them — the guard only inspects the
// hostname, so credentials are irrelevant to what's under test.
let isDestructive: (args: string[]) => boolean;
let isLocalDatabaseUrl: (url: string | undefined) => boolean;
let checkDestructiveSafety: (o: { args: string[]; databaseUrl: string | undefined; override: boolean }) => { blocked: boolean; reason: string };

beforeAll(async () => {
  const mod = await import('./destructive-guard.mjs');
  isDestructive = mod.isDestructive;
  isLocalDatabaseUrl = mod.isLocalDatabaseUrl;
  checkDestructiveSafety = mod.checkDestructiveSafety;
});

describe('isDestructive', () => {
  it('flags --force-reset', () => {
    expect(isDestructive(['db', 'push', '--force-reset'])).toBe(true);
  });
  it('flags --accept-data-loss', () => {
    expect(isDestructive(['db', 'push', '--accept-data-loss'])).toBe(true);
  });
  it('flags migrate reset', () => {
    expect(isDestructive(['migrate', 'reset'])).toBe(true);
  });
  it('flags a plain db push because it bypasses migration review', () => {
    expect(isDestructive(['db', 'push'])).toBe(true);
  });
  it('does not flag db seed / generate / studio', () => {
    expect(isDestructive(['db', 'seed'])).toBe(false);
    expect(isDestructive(['generate'])).toBe(false);
    expect(isDestructive(['studio'])).toBe(false);
  });
});

describe('isLocalDatabaseUrl', () => {
  it('treats localhost as local', () => {
    expect(isLocalDatabaseUrl('postgresql://localhost/md3_mirror')).toBe(true);
    expect(isLocalDatabaseUrl('postgresql://127.0.0.1:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://[::1]:5432/db')).toBe(true);
  });
  it('treats a Neon prod host as NOT local', () => {
    expect(isLocalDatabaseUrl('postgresql://ep-cool-name-123.us-east-2.aws.neon.tech/db?sslmode=require')).toBe(false);
  });
  it('treats an undefined/garbage URL as NOT local (fail safe)', () => {
    expect(isLocalDatabaseUrl(undefined)).toBe(false);
    expect(isLocalDatabaseUrl('')).toBe(false);
    expect(isLocalDatabaseUrl('not a url')).toBe(false);
  });
});

describe('checkDestructiveSafety', () => {
  const neon = 'postgresql://ep-x.aws.neon.tech/db';
  const local = 'postgresql://localhost/md3_mirror';

  it('blocks a destructive op against a non-local DB', () => {
    const r = checkDestructiveSafety({ args: ['db', 'push', '--force-reset'], databaseUrl: neon, override: false });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/force-reset|destructive/i);
  });
  it('allows a destructive op against localhost', () => {
    const r = checkDestructiveSafety({ args: ['migrate', 'reset'], databaseUrl: local, override: false });
    expect(r.blocked).toBe(false);
  });
  it('blocks a plain db push against production', () => {
    const r = checkDestructiveSafety({ args: ['db', 'push'], databaseUrl: neon, override: false });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/db push|destructive/i);
  });
  it('allows a destructive op against prod ONLY with explicit override', () => {
    const r = checkDestructiveSafety({ args: ['db', 'push', '--accept-data-loss'], databaseUrl: neon, override: true });
    expect(r.blocked).toBe(false);
  });
  it('never blocks a non-destructive op, even against prod', () => {
    const r = checkDestructiveSafety({ args: ['db', 'seed'], databaseUrl: neon, override: false });
    expect(r.blocked).toBe(false);
  });
  it('blocks destructive op when the URL is unknown (fail safe)', () => {
    const r = checkDestructiveSafety({ args: ['migrate', 'reset'], databaseUrl: undefined, override: false });
    expect(r.blocked).toBe(true);
  });
});
