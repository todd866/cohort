import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postContentRating } from './content-rating';

describe('postContentRating', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('posts the delivery-scoped rating payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await postContentRating({
      itemType: 'question',
      itemId: 'q1',
      serveDecisionId: 'sd1',
      rating: 'good',
      sourceComponent: 'MCQ',
    });

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/study/content-rating');
    expect(JSON.parse(init.body)).toEqual({
      itemType: 'question',
      itemId: 'q1',
      serveDecisionId: 'sd1',
      rating: 'good',
      sourceComponent: 'MCQ',
    });
  });

  it('sends clear when the rating is null, so a second press un-rates', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    void postContentRating({
      itemType: 'card', itemId: 'c1', serveDecisionId: 'sd1',
      rating: null, sourceComponent: 'KeyPoint',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).rating).toBe('clear');
  });

  it('refuses without a serveDecisionId rather than posting untraceable telemetry', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ok = await postContentRating({
      itemType: 'card', itemId: 'c1', serveDecisionId: undefined,
      rating: 'bad', sourceComponent: 'KeyPoint',
    });
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const ok = await postContentRating({
      itemType: 'card', itemId: 'c1', serveDecisionId: 'sd1',
      rating: 'good', sourceComponent: 'KeyPoint',
    });
    expect(ok).toBe(false);
  });

  it('uses the opaque Cohort delivery endpoint without a ServeDecision', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const ok = await postContentRating({
      itemType: 'card', itemId: 'opaque-delivery', serveDecisionId: undefined,
      publicDeliveryId: 'delivery-1', rating: 'good', sourceComponent: 'KeyPoint',
    });
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/cohort/feedback');
    expect(JSON.parse(init.body)).toEqual({
      deliveryId: 'delivery-1', clientRequestId: expect.any(String), kind: 'rating', rating: 'good',
    });
  });
});
