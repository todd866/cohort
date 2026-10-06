/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicReviewFigure } from './PublicReviewFigure';

function blobResponse() {
  return { ok: true, status: 200, blob: async () => new Blob(['figure'], { type: 'image/svg+xml' }) } as Response;
}

describe('PublicReviewFigure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => blobResponse()));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-figure');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: vi.fn(async () => undefined) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('prepares, decodes and reports a usable image, then reuses the prepared asset', async () => {
    const onReady = vi.fn();
    const view = render(<PublicReviewFigure src="/figure/reuse-a" alt="A figure" attribution="Authors" licenseUrl="/license" onReady={onReady} />);
    const image = await screen.findByAltText('A figure');
    fireEvent.load(image);
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true));
    expect(fetch).toHaveBeenCalledTimes(1);
    view.rerender(<PublicReviewFigure src="/figure/reuse-a" alt="A figure" attribution="Authors" licenseUrl="/license" onReady={onReady} />);
    expect(await screen.findByAltText('A figure')).toHaveAttribute('src', 'blob:test-figure');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows a retry after decode failure and retries the exact source', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset().mockResolvedValueOnce(blobResponse()).mockResolvedValueOnce(blobResponse());
    const decode = vi.fn().mockRejectedValueOnce(new Error('bad decode')).mockResolvedValue(undefined);
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: decode });
    const onReady = vi.fn();
    render(<PublicReviewFigure src="/figure/retry-b" alt="Retry figure" attribution="Authors" licenseUrl="/license" onReady={onReady} />);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Picture could not be loaded');
    expect(onReady).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry picture' }));
    const image = await screen.findByAltText('Retry figure');
    fireEvent.load(image);
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/figure/retry-b', '/figure/retry-b']);
  });
});
