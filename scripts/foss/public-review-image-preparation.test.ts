// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { bindVerifiedOfflineOwner, clearOfflineOwner } from '@/lib/offline/owner';
import { ensureFiguresCached } from '@/lib/offline/figures';
import { prepareCachedFigures } from '@/lib/offline/prepared-figures';
import { usePrepareReviewImages } from '../../src/hooks/usePrepareReviewImages';

vi.mock('@/lib/offline/figures', async importOriginal => ({
  ...await importOriginal<object>(),
  ensureFiguresCached: vi.fn(async () => ({ newlyCached: 0, availableKeys: new Set() })),
}));
vi.mock('@/lib/offline/prepared-figures', async importOriginal => ({
  ...await importOriginal<object>(), prepareCachedFigures: vi.fn(async () => {}),
}));
const items = [{ imageKey: '/open-media/base.png', imageUrl: '/open-media/base.png',
  imageAlternatives: [{ imageKey: '/open-media/new.png', imageUrl: '/open-media/new.png' }] }];

describe('public review preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearOfflineOwner(); bindVerifiedOfflineOwner('public-owner');
  });
  it('prepares the initially delivered open image and its alternative before a later fetch', async () => {
    renderHook(() => usePrepareReviewImages(items, 0, 'public-owner', false));
    await waitFor(() => expect(ensureFiguresCached).toHaveBeenCalledWith(['/open-media/base.png', '/open-media/new.png'], 'public-owner'));
    expect(prepareCachedFigures).toHaveBeenCalledWith(['/open-media/base.png', '/open-media/new.png'], 'public-owner');
  });
  it('decodes the offline window without downloading media', async () => {
    renderHook(() => usePrepareReviewImages(items, 0, 'public-owner', true));
    await waitFor(() => expect(prepareCachedFigures).toHaveBeenCalled());
    expect(ensureFiguresCached).not.toHaveBeenCalled();
  });
});
