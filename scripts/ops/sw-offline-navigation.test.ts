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
  );

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
  const cache = { put: vi.fn(), match: vi.fn(), keys: vi.fn() };
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
    fetchMock,
    postMessage,
    dispatchFetch: (request, clientId = 'client-1') => {
      let response: Promise<Response> | undefined;
      fetchListener({
        request,
        clientId,
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
});
