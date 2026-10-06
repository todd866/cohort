/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicReviewFeedback } from './PublicReviewFeedback';

vi.mock('@/lib/client-request-id', () => ({ genClientRequestId: () => 'feedback-request-1' }));

describe('PublicReviewFeedback', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => vi.unstubAllGlobals());

  it('retries a failed rating with the identical request body', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onOpenChange = vi.fn();
    render(<PublicReviewFeedback deliveryId="delivery-1" open={false} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Good content' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Feedback saved'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      deliveryId: 'delivery-1', clientRequestId: 'feedback-request-1', kind: 'rating', rating: 'good',
    });
  });
});
