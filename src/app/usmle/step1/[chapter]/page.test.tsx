/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notFound, redirect } from 'next/navigation';
import LegacyChapterPage from './page';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('not-found'); }),
  redirect: vi.fn(() => { throw new Error('redirect'); }),
}));

describe('legacy USMLE Step 1 chapter routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects old chapter bookmarks to the cleared product home', async () => {
    await expect(LegacyChapterPage({
      params: Promise.resolve({ chapter: 'biochemistry' }),
    })).rejects.toThrow('redirect');

    expect(redirect).toHaveBeenCalledWith('/usmle/step1');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('keeps unknown chapter paths closed', async () => {
    await expect(LegacyChapterPage({
      params: Promise.resolve({ chapter: 'commercial-bank' }),
    })).rejects.toThrow('not-found');

    expect(notFound).toHaveBeenCalledOnce();
    expect(redirect).not.toHaveBeenCalled();
  });
});
