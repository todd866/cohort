import { beforeEach, describe, expect, it, vi } from 'vitest';

const images = vi.hoisted(() => ({ focus: vi.fn(), source: vi.fn() }));
vi.mock('@/lib/figures/anatomy-focus-figure.server', () => ({ anatomyFocusSvg: images.focus }));
vi.mock('@/lib/figures/anatomy-source-figure.server', () => ({ readAnatomySourceFigure: images.source }));
// The real hostname boundary remains active; only the reviewed asset store is replaced.
import { GET, HEAD } from './route';

const url = 'https://cohort.md/api/anatomy/figure';
const focus = '?figure=heart-valves-focus&target=mitral&phase=prompt';
const source = '?figure=humerus&target=overview&phase=answer';
beforeEach(() => {
  vi.clearAllMocks();
  images.focus.mockReturnValue('<svg><title>Structure A</title></svg>');
  images.source.mockReturnValue({ bytes: new Uint8Array([1, 2, 3]), figure: { mime: 'image/jpeg' } });
});

describe('reviewed public anatomy figure route', () => {
  it.each(['md3.info', 'cohort.md.evil.example', 'example.com'])('blocks %s before reading assets', host => {
    expect(GET(new Request(`https://${host}/api/anatomy/figure${focus}`)).status).toBe(404);
    expect(images.focus).not.toHaveBeenCalled();
    expect(images.source).not.toHaveBeenCalled();
  });
  it('uses the real incoming host for a local application server', () => {
    expect(GET(new Request(`http://127.0.0.1:3018/api/anatomy/figure${focus}`, { headers: { host: 'cohort.md' } })).status).toBe(200);
    expect(GET(new Request(url + focus, { headers: { host: 'md3.info' } })).status).toBe(404);
  });
  it.each([
    '?figure=humerus&target=overview&phase=prompt',
    '?figure=humerus&target=overview&phase=answer&phase=prompt',
    '?figure=humerus&target=overview&phase=answer&path=private.png',
    '?figure=humerus&phase=answer',
  ])('rejects unreviewed query selection %s', query => {
    expect(GET(new Request(url + query)).status).toBe(404);
    expect(images.source).not.toHaveBeenCalled();
  });
  it('delivers a prompt only through the reviewed focus renderer', async () => {
    const response = GET(new Request(url + focus));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Structure A');
    expect(images.focus).toHaveBeenCalledWith('heart-valves-focus', 'mitral', 'prompt');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('does not fall back to unreviewed media when a focus candidate is held', () => {
    images.focus.mockReturnValue(null);
    expect(GET(new Request(url + focus)).status).toBe(404);
    expect(images.source).not.toHaveBeenCalled();
  });
  it('serves a reviewed labelled overview only after reveal, and HEAD has no body', async () => {
    const response = GET(new Request(url + source));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const head = HEAD(new Request(url + source));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
  it('refuses an overview whose reviewed bytes are unavailable', () => {
    images.source.mockReturnValue(null);
    expect(GET(new Request(url + source)).status).toBe(404);
  });
});
