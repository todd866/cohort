import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import AnatomyPage from './page';
import AnatomyStudyClient from './AnatomyStudyClient';

describe('/anatomy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is Cohort-only and renders the public study client', async () => {
    mocks.headers.mockResolvedValue(new Headers({ host: 'cohort.md' }));
    const result = (await AnatomyPage()) as { type: unknown };
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(result.type).toBe(AnatomyStudyClient);
  });

  it.each(['md3.info', 'evil-cohort.md.example'])('uses the ordinary MD3 module entry on %s', async (host) => {
    mocks.headers.mockResolvedValue(new Headers({ host }));
    await expect(AnatomyPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/?rotation=anatomy');
  });
});
