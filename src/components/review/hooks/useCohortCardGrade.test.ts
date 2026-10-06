/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCohortCardGrade } from './useCohortCardGrade';

describe('useCohortCardGrade', () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
  });
  afterEach(() => vi.restoreAllMocks());

  const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, deduped: false }) });

  it('waits for the server to record the grade before moving on', async () => {
    let release!: () => void;
    mockFetch.mockImplementation(() => new Promise((resolve) => { release = () => resolve(ok()); }));
    const onGraded = vi.fn();
    const { result } = renderHook(() => useCohortCardGrade({
      deliveryId: 'delivery-000001', getResponseTimeMs: () => 4_200, onGraded,
    }));

    act(() => result.current.grade(3));
    expect(result.current.status).toBe('saving');
    expect(result.current.selected).toBe(3);
    expect(onGraded).not.toHaveBeenCalled();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/cohort/card-grade');
    expect(JSON.parse(init.body)).toEqual({
      deliveryId: 'delivery-000001', confidence: 3, clientRequestId: expect.any(String), responseTimeMs: 4_200,
    });

    // One tap does one thing: a second grade while saving is ignored.
    act(() => result.current.grade(4));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => { release(); });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(onGraded).toHaveBeenCalledWith(3);
  });

  it('reports a failure, and retries the same grade with the same request id', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'busy' }) })
      .mockImplementationOnce(ok);
    const onError = vi.fn();
    const onGraded = vi.fn();
    const { result } = renderHook(() => useCohortCardGrade({ deliveryId: 'delivery-000001', onGraded, onError }));

    await act(async () => { result.current.grade(2); });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(onError).toHaveBeenCalledWith('busy');
    expect(onGraded).not.toHaveBeenCalled();

    await act(async () => { result.current.grade(2); });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    const ids = mockFetch.mock.calls.map(([, init]) => JSON.parse(init.body).clientRequestId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('retries the complete grade body, including the original response time', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'busy' }) })
      .mockImplementationOnce(ok);
    const responseTimes = vi.fn()
      .mockReturnValueOnce(4_200)
      .mockReturnValueOnce(9_800);
    const { result } = renderHook(() => useCohortCardGrade({
      deliveryId: 'delivery-000001', getResponseTimeMs: responseTimes,
    }));

    await act(async () => { result.current.grade(3); });
    await waitFor(() => expect(result.current.status).toBe('error'));
    await act(async () => { result.current.grade(3); });
    await waitFor(() => expect(result.current.status).toBe('saved'));

    const bodies = mockFetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(responseTimes).toHaveBeenCalledTimes(1);
  });

  it('ignores a late grade result after the delivery changes', async () => {
    let release!: (response: Response) => void;
    mockFetch.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    const onGraded = vi.fn();
    const { result, rerender } = renderHook(({ id }) => useCohortCardGrade({ deliveryId: id, onGraded }), {
      initialProps: { id: 'delivery-000001' },
    });
    act(() => result.current.grade(3));
    rerender({ id: 'delivery-000002' });
    await act(async () => { release(new Response(JSON.stringify({ ok: true }), { status: 200 })); });
    expect(onGraded).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('ignores a result invalidated by reset on the same delivery', async () => {
    let release!: (response: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
      .mockImplementationOnce(ok);
    const onGraded = vi.fn();
    const { result } = renderHook(() => useCohortCardGrade({ deliveryId: 'delivery-000001', onGraded }));
    act(() => result.current.grade(3));
    act(() => result.current.reset());
    await act(async () => { result.current.grade(4); });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    await act(async () => { release(new Response('{}', { status: 503 })); });
    expect(result.current.status).toBe('saved');
    expect(onGraded).toHaveBeenCalledTimes(1);
    expect(onGraded).toHaveBeenCalledWith(4);
  });

  it('freezes the continuation receipt on retry and prepares it before advancing', async () => {
    const nextTurn = { serveRequestId: 'next-001', journeyId: 'journey-001', nextDrawOrdinal: 1, previousDeliveryId: 'delivery-000001' };
    const response = { sessionId: 'journey-001', items: [] };
    mockFetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, nextTurn: response }) });
    const getNextTurn = vi.fn(() => nextTurn);
    const order: string[] = [];
    const onNextTurn = vi.fn(() => { order.push('prepare'); });
    const { result } = renderHook(() => useCohortCardGrade({
      deliveryId: 'delivery-000001', getNextTurn, onNextTurn,
      onGraded: () => { order.push('advance'); },
    }));
    await act(async () => { result.current.grade(1); });
    await waitFor(() => expect(result.current.status).toBe('error'));
    await act(async () => { result.current.grade(1); });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(getNextTurn).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].body).toBe(mockFetch.mock.calls[1][1].body);
    expect(onNextTurn).toHaveBeenCalledWith(nextTurn, response);
    expect(order).toEqual(['prepare', 'advance']);
  });

  it('resets for the next delivery', async () => {
    mockFetch.mockImplementation(ok);
    const { result, rerender } = renderHook(({ id }) => useCohortCardGrade({ deliveryId: id }), {
      initialProps: { id: 'delivery-000001' },
    });
    await act(async () => { result.current.grade(4); });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    rerender({ id: 'delivery-000002' });
    expect(result.current.status).toBe('idle');
    expect(result.current.selected).toBeNull();
  });
});
