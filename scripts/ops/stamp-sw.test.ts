import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const STAMP_SCRIPT = join(REPO_ROOT, 'scripts/ops/stamp-sw.sh');

function tempSw(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sw-stamp-'));
  const f = join(dir, 'sw.js');
  writeFileSync(f, contents);
  return f;
}

describe('public/sw.js build stamp (recurrence guard)', () => {
  it('keeps the __BUILD_STAMP__ placeholder so each deploy ships a fresh, updatable SW', () => {
    // If this fails, someone committed the post-stamp output and froze the SW —
    // browsers will never fetch a new service worker. Restore with:
    //   git checkout -- public/sw.js
    const sw = readFileSync(join(REPO_ROOT, 'public/sw.js'), 'utf8');
    expect(sw).toContain('__BUILD_STAMP__');
  });

  it('caches only immutable same-origin build assets', () => {
    const sw = readFileSync(join(REPO_ROOT, 'public/sw.js'), 'utf8');
    expect(sw).toContain('url.origin !== self.location.origin');
    expect(sw).toContain("url.pathname.startsWith('/_next/static/')");
    expect(sw).not.toContain('md3-sessions-v1');
    expect(sw).not.toContain('staleWhileRevalidateSession');
    expect(sw).not.toContain('event.respondWith(networkFirst');
  });

  it('purges every cache outside the keep-list on activation', () => {
    const sw = readFileSync(join(REPO_ROOT, 'public/sw.js'), 'utf8');
    expect(sw).toContain("const CACHE_NAME = 'md3-static-v2'");
    expect(sw).toContain("const FIGURE_CACHE = 'md3-figures-v1'");
    // The keep-list is the whole allowance: build assets, the credentialless
    // offline shell, and figure bytes explicitly stored after entitlement.
    expect(sw).toContain('const KEEP_CACHES = [CACHE_NAME, SHELL_CACHE, FIGURE_CACHE]');
    expect(sw).toContain(
      'keys.filter((key) => !KEEP_CACHES.includes(key)).map((key) => caches.delete(key))',
    );
  });

  it('passes Next RSC requests through without caching and reports failures to the client', () => {
    const sw = readFileSync(join(REPO_ROOT, 'public/sw.js'), 'utf8');
    expect(sw).toContain("request.headers.get('RSC') === '1'");
    expect(sw).toContain("url.searchParams.has('_rsc')");
    expect(sw).toContain('url.pathname,');
    expect(sw).toContain('event.clientId,');

    const start = sw.indexOf('async function networkThenReportRscFailure');
    const end = sw.indexOf('async function networkThenShell', start);
    const handler = sw.slice(start, end);
    expect(handler).toContain('return await fetchNavigationNetwork(request)');
    expect(handler).toContain("client?.postMessage({ type: 'md3-rsc-navigation-failed', path })");
    expect(handler).toContain('throw err');
    expect(handler).not.toContain('cache.put');
    expect(handler).not.toContain('cache.add');
    expect(handler).not.toContain('caches.match');
    expect(sw).toContain('const NAVIGATION_NETWORK_DEADLINE_MS = 10_000');
    expect(sw).toContain('const TRANSIENT_GATEWAY_STATUSES = [502, 503, 504]');
  });

  it('never writes a navigation response to a cache', () => {
    // v1 cached navigations by URL, which retained one user's rendered pages
    // across logout. The offline fallback must not reintroduce that: navigations
    // are served from the network and forgotten, and the ONLY document in a
    // cache is /offline, which is fetched unauthenticated and is user-agnostic.
    const sw = readFileSync(join(REPO_ROOT, 'public/sw.js'), 'utf8');
    const handler = sw.slice(sw.indexOf('async function networkThenShell'));
    expect(handler).not.toContain('cache.put');
    expect(handler).not.toContain('cache.add');
    expect(sw).toContain("const OFFLINE_ROUTE = '/offline'");
  });
});

describe('stamp-sw.sh', () => {
  it('replaces the placeholder with a build stamp (on a file passed as $1)', () => {
    const f = tempSw('// build: __BUILD_STAMP__\nconst x = 1;\n');
    execFileSync('sh', [STAMP_SCRIPT, f], { cwd: REPO_ROOT });
    const out = readFileSync(f, 'utf8');
    expect(out).not.toContain('__BUILD_STAMP__');
    expect(out).toMatch(/^\/\/ build: \S+/);
  });

  it('fails loudly (non-zero exit) when the placeholder is missing', () => {
    // An already-stamped / frozen file must break the build, not silently no-op.
    const f = tempSw('// build: abc1234\nconst x = 1;\n');
    expect(() =>
      execFileSync('sh', [STAMP_SCRIPT, f], { cwd: REPO_ROOT, stdio: 'pipe' })
    ).toThrow();
  });
});
