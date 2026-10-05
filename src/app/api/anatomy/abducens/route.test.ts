import { describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ deliver: vi.fn((_segments: string[], body: boolean) => new Response(body ? '<svg />' : null, { status: 200 })) }));
vi.mock('@/lib/figures/open-figure-delivery', () => ({
  openFigureResponse: mock.deliver,
  readOpenFigure: () => '<svg><g id="label-lr-label" data-target-region="lateral-rectus"><text>Lateral rectus</text></g><g id="label-vi-label" data-target-region="abducens"><text>CN VI</text></g><g id="label-optic-label" data-target-region="optic-nerve"><text>Optic nerve</text></g></svg>',
  blockedFigureResponse: () => new Response(null, { status: 404 }),
}));
import { GET, HEAD } from './route';
describe('public abducens illustration', () => {
  it.each(['md3.info', 'evil-cohort.md.example'])('denies %s', host => {
    mock.deliver.mockClear();
    expect(GET(new Request(`https://${host}/api/anatomy/abducens`)).status).toBe(404);
    expect(mock.deliver).not.toHaveBeenCalled();
  });
  it('delivers only the fixed reviewed asset even with path-like query input', async () => {
    const response = GET(new Request('https://cohort.md/api/anatomy/abducens?path=../../private.png'));
    expect(await response.text()).toBe('<svg />');
    expect(mock.deliver).toHaveBeenLastCalledWith(['anatomy', 'abducens-local.svg'], true, { hostname: 'cohort.md' });
  });
  it('uses the incoming virtual host when the app server has a local URL', () => {
    expect(GET(new Request('http://127.0.0.1:3017/api/anatomy/abducens', { headers: { host: 'cohort.md:3017' } })).status).toBe(200);
    expect(GET(new Request('https://cohort.md/api/anatomy/abducens', { headers: { host: 'md3.info' } })).status).toBe(404);
  });
  it('serves HEAD without a body', async () => {
    expect(await HEAD(new Request('https://www.cohort.md/api/anatomy/abducens')).text()).toBe('');
    expect(mock.deliver).toHaveBeenLastCalledWith(['anatomy', 'abducens-local.svg'], false, { hostname: 'cohort.md' });
  });
  it('serves an answer-concealed prompt from the admitted image', async () => {
    const response = GET(new Request('https://cohort.md/api/anatomy/abducens?phase=prompt&target=abducens'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<text>A</text>');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it.each(['phase=prompt', 'phase=unknown', 'target=../../secret', 'phase=prompt&target=other'])('rejects unreviewed parameters %s', query => {
    expect(GET(new Request(`https://cohort.md/api/anatomy/abducens?${query}`)).status).toBe(404);
  });

});
