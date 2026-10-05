import { describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ deliver: vi.fn((_segments: string[], body: boolean) => new Response(body ? '<svg />' : null, { status: 200 })) }));
vi.mock('@/lib/figures/open-figure-delivery', () => ({
  openFigureResponse: mock.deliver,
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
});
