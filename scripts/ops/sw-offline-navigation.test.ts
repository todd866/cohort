import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SW_PATH = `${process.cwd()}/public/sw.js`;

interface WorkerHarness {
  dispatchFetch: (
    request: {
      method: string;
      mode: string;
      url: string;
      headers: Headers;
    },
    clientId?: string,
  ) => Promise<Response>;
  cachesMatch: ReturnType<typeof vi.fn>;
  cachesOpen: ReturnType<typeof vi.fn>;
  cachesKeys: ReturnType<typeof vi.fn>;
  cachePut: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  dispatchLifecycle: (name: string) => Promise<unknown>;
  background: Promise<unknown>[];
  fetchMock: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

function loadWorker(fetchMock: ReturnType<typeof vi.fn>): WorkerHarness {
  const listeners = new Map<string, (event: unknown) => void>();
  const postMessage = vi.fn();
  const cachesMatch = vi.fn();
  const source = readFileSync(SW_PATH, 'utf8').replace(
    'const NAVIGATION_NETWORK_DEADLINE_MS = 10_000;',
    'const NAVIGATION_NETWORK_DEADLINE_MS = 5;',
  ).replace('const STATIC_CACHE_LOOKUP_DEADLINE_MS = 1_000;', 'const STATIC_CACHE_LOOKUP_DEADLINE_MS = 5;');

  const workerSelf = {
    location: { origin: 'https://md3.info' },
    clients: {
      claim: vi.fn(),
      get: vi.fn().mockResolvedValue({ postMessage }),
    },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
  };
  const cache = { put: vi.fn().mockResolvedValue(undefined), match: vi.fn(), keys: vi.fn() };
  const background: Promise<unknown>[] = [];
  const workerCaches = {
    match: cachesMatch,
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
  };

  runInNewContext(source, {
    self: workerSelf,
    caches: workerCaches,
    fetch: fetchMock,
    URL,
    AbortController,
    Headers,
    Response,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
  });

  const fetchListener = listeners.get('fetch');
  if (!fetchListener) throw new Error('Service worker did not register a fetch listener');

  return {
    cachesMatch,
    cachesOpen: workerCaches.open,
    cachesKeys: workerCaches.keys,
    cachePut: cache.put,
    skipWaiting: workerSelf.skipWaiting,
    claim: workerSelf.clients.claim,
    background,
    dispatchLifecycle: (name) => {
      let work: Promise<unknown> | undefined;
      listeners.get(name)?.({ waitUntil(value: Promise<unknown>) { work = Promise.resolve(value); } });
      if (!work) throw new Error(`Lifecycle ${name} did not register work`);
      return work;
    },
    fetchMock,
    postMessage,
    dispatchFetch: (request, clientId = 'client-1') => {
      let response: Promise<Response> | undefined;
      fetchListener({
        request,
        clientId,
        waitUntil(work: Promise<unknown>) { background.push(Promise.resolve(work)); },
        respondWith(value: Promise<Response>) {
          response = Promise.resolve(value);
        },
      });
      if (!response) throw new Error('Service worker did not handle the request');
      return response;
    },
  };
}

function request(
  path: string,
  options: { mode?: string; rsc?: boolean } = {},
) {
  const headers = new Headers();
  if (options.rsc) headers.set('RSC', '1');
  return {
    method: 'GET',
    mode: options.mode ?? 'cors',
    url: `https://md3.info${path}`,
    headers,
  };
}

describe('service-worker offline navigation runtime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts a black-holed RSC request while the clicked intent is still live', async () => {
    const fetchMock = vi.fn((_request: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    );
    const harness = loadWorker(fetchMock);

    await expect(harness.dispatchFetch(request('/content?_rsc=abc', { rsc: true })))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.postMessage).toHaveBeenCalledWith({
      type: 'md3-rsc-navigation-failed',
      path: '/content',
    });
  });

  it('treats a transient gateway response as a failed navigation and serves the shell', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('temporarily unavailable', { status: 503 }),
    );
    const harness = loadWorker(fetchMock);
    const shell = new Response('<!doctype html><title>Offline</title>', {
      headers: { 'Content-Type': 'text/html' },
    });
    harness.cachesMatch.mockResolvedValue(shell);

    const response = await harness.dispatchFetch(
      request('/content', { mode: 'navigate' }),
    );

    expect(await response.text()).toContain('<title>Offline</title>');
    expect(harness.cachesMatch).toHaveBeenCalledWith('/offline');
  });

  it.each(['reject', 'stall'] as const)('preserves a navigation failure when offline storage will %s', async (failure) => {
    const networkError = new Error('Network offline');
    const harness = loadWorker(vi.fn().mockRejectedValue(networkError));
    if (failure === 'reject') harness.cachesMatch.mockRejectedValue(new Error('Storage unavailable'));
    else harness.cachesMatch.mockImplementation(() => new Promise(() => {}));
    await expect(harness.dispatchFetch(request('/content', { mode: 'navigate' })))
      .rejects.toBe(networkError);
  });
});

describe('service-worker build assets when phone storage is unavailable', () => {
  const asset = () => request('/_next/static/chunks/review-test.js?dpl=current');
  const networkResponse = () => new Response('self.reviewChunkLoaded = true;', {
    headers: { 'Content-Type': 'application/javascript' },
  });

  it('delivers a healthy network script when CacheStorage lookup rejects', async () => {
    const harness = loadWorker(vi.fn().mockResolvedValue(networkResponse()));
    harness.cachesMatch.mockRejectedValue(new DOMException('Storage unavailable', 'UnknownError'));
    expect(await (await harness.dispatchFetch(asset())).text()).toContain('reviewChunkLoaded');
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    await Promise.all(harness.background);
  });

  it('falls back to the network when a cache lookup never settles', async () => {
    const harness = loadWorker(vi.fn().mockResolvedValue(networkResponse()));
    harness.cachesMatch.mockImplementation(() => new Promise(() => {}));
    expect(await (await harness.dispatchFetch(asset())).text()).toContain('reviewChunkLoaded');
    await Promise.all(harness.background);
  });

  it.each(['open', 'put'] as const)('does not turn a cache %s rejection into a failed script', async (stage) => {
    const harness = loadWorker(vi.fn().mockResolvedValue(networkResponse()));
    const error = new DOMException('No cache space', 'QuotaExceededError');
    if (stage === 'open') harness.cachesOpen.mockRejectedValue(error);
    else harness.cachePut.mockRejectedValue(error);
    expect(await (await harness.dispatchFetch(asset())).text()).toContain('reviewChunkLoaded');
    // Waiting for background work also exposes an unhandled put rejection.
    expect(harness.background).toHaveLength(1);
    await expect(Promise.all(harness.background)).resolves.toBeDefined();
  });

  it('returns the script without waiting for a stalled cache write', async () => {
    const harness = loadWorker(vi.fn().mockResolvedValue(networkResponse()));
    let finishOpen!: (cache: { put: () => Promise<void> }) => void;
    harness.cachesOpen.mockImplementation(() => new Promise(resolve => { finishOpen = resolve; }));
    const response = await harness.dispatchFetch(asset());
    expect(await response.text()).toContain('reviewChunkLoaded');
    finishOpen({ put: async () => {} });
    await Promise.all(harness.background);
  });

  it('reuses cached assets without making a network request', async () => {
    const harness = loadWorker(vi.fn());
    harness.cachesMatch.mockResolvedValue(networkResponse());
    expect(await (await harness.dispatchFetch(asset())).text()).toContain('reviewChunkLoaded');
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it('installs and takes control even when the cache API is broken', async () => {
    const harness = loadWorker(vi.fn());
    harness.cachesOpen.mockRejectedValue(new DOMException('Storage unavailable', 'UnknownError'));
    harness.cachesKeys.mockRejectedValue(new DOMException('Storage unavailable', 'UnknownError'));
    await expect(harness.dispatchLifecycle('install')).resolves.toBeUndefined();
    await expect(harness.dispatchLifecycle('activate')).resolves.toBeUndefined();
    expect(harness.skipWaiting).toHaveBeenCalledOnce();
    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it('takes control when old-cache cleanup never settles', async () => {
    const harness = loadWorker(vi.fn());
    harness.cachesKeys.mockImplementation(() => new Promise(() => {}));
    await expect(harness.dispatchLifecycle('activate')).resolves.toBeUndefined();
    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it('keeps genuine network failures visible and never caches an error response', async () => {
    const harness = loadWorker(vi.fn().mockRejectedValue(new Error('Network offline')));
    await expect(harness.dispatchFetch(asset())).rejects.toThrow('Network offline');
    harness.fetchMock.mockResolvedValue(new Response('Not found', { status: 404 }));
    expect((await harness.dispatchFetch(asset())).status).toBe(404);
    expect(harness.cachePut).not.toHaveBeenCalled();
  });
});
