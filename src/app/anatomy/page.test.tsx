import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));

import AnatomyPage from './page';
import AnatomyStudyClient from './AnatomyStudyClient';

describe('/anatomy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is Cohort-only and renders the public study client', async () => {
    mocks.headers.mockResolvedValue(new Headers({ host: 'cohort.md' }));
    const result = (await AnatomyPage()) as { type: unknown };
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(result.type).toBe(AnatomyStudyClient);
  });

  it.each(['md3.info', 'evil-cohort.md.example'])('does not serve on %s', async (host) => {
    mocks.headers.mockResolvedValue(new Headers({ host }));
    await expect(AnatomyPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalled();
  });
});
