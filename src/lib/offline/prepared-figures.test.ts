// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCachedFigure } from './figures';
import { bindVerifiedOfflineOwner, clearOfflineOwner } from './owner';
import { acquirePreparedFigure, clearPreparedFigures, peekPreparedFigure, prepareCachedFigures } from './prepared-figures';

vi.mock('./figures', () => ({ readCachedFigure: vi.fn() }));

describe('decoded review figures', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    clearPreparedFigures();
    localStorage.clear();
    clearOfflineOwner();
    bindVerifiedOfflineOwner('user-a');
    vi.mocked(readCachedFigure).mockReset().mockImplementation(async key => `blob:${key}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('Image', class { src = ''; decode = vi.fn(async () => {}); });
  });

  it('decodes saved bytes once and supplies the exact preloaded URL without networking', async () => {
    await prepareCachedFigures(['/figures/a.png'], 'user-a');
    await prepareCachedFigures(['/figures/a.png'], 'user-a');
    expect(readCachedFigure).toHaveBeenCalledTimes(1);
    expect(peekPreparedFigure('/figures/a.png')).toBe('blob:/figures/a.png');
    const held = acquirePreparedFigure('/figures/a.png');
    expect(held?.url).toBe('blob:/figures/a.png');
    expect(fetch).not.toHaveBeenCalled();
    held?.release();
  });

  it('keeps an image mounted by the renderer alive when the lookahead window changes', async () => {
    await prepareCachedFigures(['/figures/a.png'], 'user-a');
    const held = acquirePreparedFigure('/figures/a.png')!;
    await prepareCachedFigures(['/figures/b.png'], 'user-a');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(held.url);
    held.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(held.url);
    expect(peekPreparedFigure('/figures/a.png')).toBeNull();
  });

  it('rejects late bytes and revokes ready URLs across account generations', async () => {
    await prepareCachedFigures(['/figures/a.png'], 'user-a');
    let finish!: (url: string) => void;
    vi.mocked(readCachedFigure).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = prepareCachedFigures(['/figures/b.png'], 'user-a');
    bindVerifiedOfflineOwner('user-b');
    finish('blob:late-a');
    await pending;
    expect(peekPreparedFigure('/figures/a.png')).toBeNull();
    expect(peekPreparedFigure('/figures/b.png')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late-a');
  });

  it('does not claim decode failures are ready and retries when preparation runs again', async () => {
    vi.stubGlobal('Image', class { src = ''; decode = vi.fn(async () => { throw new Error('bad image'); }); });
    await prepareCachedFigures(['/figures/a.png'], 'user-a');
    expect(peekPreparedFigure('/figures/a.png')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:/figures/a.png');
    vi.stubGlobal('Image', class { src = ''; decode = vi.fn(async () => {}); });
    await prepareCachedFigures(['/figures/a.png'], 'user-a');
    expect(peekPreparedFigure('/figures/a.png')).toBe('blob:/figures/a.png');
  });

  it('releases a hung cache read for retry and revokes any bytes that arrive after its deadline', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (url: string) => void;
      vi.mocked(readCachedFigure).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      let settled = false;
      const first = prepareCachedFigures(['/figures/a.png'], 'user-a').then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(15_100);
      expect(settled).toBe(true);
      await first;
      expect(peekPreparedFigure('/figures/a.png')).toBeNull();
      await prepareCachedFigures(['/figures/a.png'], 'user-a');
      expect(peekPreparedFigure('/figures/a.png')).toBe('blob:/figures/a.png');
      finish('blob:expired-read');
      await vi.advanceTimersByTimeAsync(0);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:expired-read');
      expect(peekPreparedFigure('/figures/a.png')).toBe('blob:/figures/a.png');
    } finally { vi.useRealTimers(); }
  });
});
