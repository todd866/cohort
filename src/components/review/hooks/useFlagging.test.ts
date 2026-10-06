// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const submitFlag = vi.hoisted(() => vi.fn().mockResolvedValue('delivered'));
vi.mock('@/lib/flag-submit', () => ({ submitFlag }));

import { useFlagging } from './useFlagging';

const item = { id: 'c1', type: 'card' };
const noopRegister = () => () => {};

describe('useFlagging', () => {
  beforeEach(() => { submitFlag.mockReset(); submitFlag.mockResolvedValue('delivered'); });
  afterEach(() => { vi.clearAllMocks(); });

  it('keeps note and thumbnail after a text-only acknowledgement', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:kept'); URL.revokeObjectURL = vi.fn();
    submitFlag.mockResolvedValue('image-unavailable');
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    act(() => { result.current.setFlagMode(true); result.current.setFlagMessage('Screenshot note'); result.current.image.choose(new File(['bytes'], 'image.png', { type: 'image/png' })); });
    vi.spyOn(result.current.image, 'prepare').mockResolvedValue('attachment');
    await act(async () => { result.current.handleFlagSubmit(); });
    expect(result.current.flagMode).toBe(true); expect(result.current.flagged).toBe(false);
    expect(result.current.flagMessage).toBe('Screenshot note'); expect(result.current.image.preview).toBe('blob:kept');
    expect(result.current.image.error).toContain('image was not attached'); expect(result.current.flagPending).toBe(false);
  });

  it('submits reason "Other" (never the unmapped "flag") with the note', async () => {
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    act(() => { result.current.setFlagMessage('broken cloze'); });
    await act(async () => { result.current.handleFlagSubmit(); });
    expect(submitFlag).toHaveBeenCalledWith(expect.objectContaining({
      id: 'c1', type: 'card', reason: 'Other', message: 'broken cloze',
    }));
  });

  it('addresses a public question only by its opaque delivery capability', async () => {
    const publicItem = {
      id: 'canonical-question-id-must-not-cross-the-client-boundary',
      type: 'question',
      deliveryId: 'delivery-opaque-000001',
    };
    const { result } = renderHook(() => useFlagging({
      item: publicItem,
      registerResetCallback: noopRegister,
    }));

    await act(async () => { result.current.handleFlagSubmit(); });

    expect(submitFlag).toHaveBeenCalledWith(expect.objectContaining({
      type: 'question',
      id: 'delivery-opaque-000001',
      deliveryId: 'delivery-opaque-000001',
      reason: 'Other',
    }));
    expect(JSON.stringify(submitFlag.mock.calls[0][0])).not.toContain(
      'canonical-question-id-must-not-cross-the-client-boundary',
    );
  });

  it('flags an exact practice retest through its opaque question capability', async () => {
    const { result } = renderHook(() => useFlagging({ item: {
      id: 'practice-retest:delivery-1', type: 'question', deliveryId: 'delivery-1',
      answerSource: 'practice-exam-follow-up',
      practiceReview: { kind: 'exam-topic-follow-up', priority: 'wrong', rotation: 'cah', submittedAt: '2026-09-27T00:00:00.000Z', source: {
        paperId: 'cah-2026-paper-a', paperTitle: 'CAH Paper A', paperPath: '/practice-exam/cah/paper-a', itemId: 'cah-a-022',
        questionNumber: 22, sourceSubmittedAt: '2026-09-27T00:00:00.000Z', attemptId: '11111111-1111-4111-8111-111111111111',
      } },
    }, registerResetCallback: noopRegister }));
    await act(async () => { result.current.handleFlagSubmit(); });
    const body = submitFlag.mock.calls[0][0];
    expect(body).toMatchObject({ type: 'question', id: 'delivery-1', deliveryId: 'delivery-1', context: { componentType: 'practice-exam-item', path: '/practice-exam/cah/paper-a' } });
    expect(JSON.stringify(body)).not.toContain('practice-retest:');
  });

  it('sets flagged only after submitFlag resolves delivered', async () => {
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    expect(result.current.flagged).toBe(false);
    await act(async () => { result.current.handleFlagSubmit(); });
    await waitFor(() => expect(result.current.flagged).toBe(true));
  });

  it('does NOT set flagged when submit is queued (offline)', async () => {
    submitFlag.mockResolvedValue('queued');
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    await act(async () => { result.current.handleFlagSubmit(); });
    expect(result.current.flagged).toBe(false);
  });

  it('sets authExpired (and not flagged) when submit needs auth', async () => {
    submitFlag.mockResolvedValue('auth-required');
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    await act(async () => { result.current.handleFlagSubmit(); });
    await waitFor(() => expect(result.current.authExpired).toBe(true));
    expect(result.current.flagged).toBe(false);
  });

  it('does NOT set authExpired on confirmed delivery', async () => {
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    await act(async () => { result.current.handleFlagSubmit(); });
    await waitFor(() => expect(result.current.flagged).toBe(true));
    expect(result.current.authExpired).toBe(false);
  });

  it('ignores a second submit while the first is in-flight (no duplicate enqueue)', async () => {
    let resolveFn: (v: string) => void = () => {};
    submitFlag.mockReturnValue(new Promise<string>((r) => { resolveFn = r; }));
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    act(() => { result.current.handleFlagSubmit(); });
    act(() => { result.current.handleFlagSubmit(); }); // F-spam before the first resolves
    expect(submitFlag).toHaveBeenCalledTimes(1);
    await act(async () => { resolveFn('delivered'); });
  });

  it('exposes flagPending while in-flight, clears it on delivery', async () => {
    let resolveFn: (v: string) => void = () => {};
    submitFlag.mockReturnValue(new Promise<string>((r) => { resolveFn = r; }));
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    act(() => { result.current.handleFlagSubmit(); });
    expect(result.current.flagPending).toBe(true);
    await act(async () => { resolveFn('delivered'); });
    await waitFor(() => expect(result.current.flagPending).toBe(false));
    expect(result.current.flagged).toBe(true);
  });

  it('stays pending after a queued submit and blocks re-submit (no duplicate clientRequestId)', async () => {
    submitFlag.mockResolvedValue('queued');
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    await act(async () => { result.current.handleFlagSubmit(); });
    expect(result.current.flagPending).toBe(true);
    expect(result.current.flagged).toBe(false);
    await act(async () => { result.current.handleFlagSubmit(); }); // would mint a new clientRequestId
    expect(submitFlag).toHaveBeenCalledTimes(1);
  });

  it('allows a second distinct flag on the same card after the first is delivered', async () => {
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    // First flag delivered
    act(() => { result.current.setFlagMessage('needs image'); });
    await act(async () => { result.current.handleFlagSubmit(); });
    await waitFor(() => expect(result.current.flagged).toBe(true));
    expect(submitFlag).toHaveBeenCalledTimes(1);
    // A second, different flag on the SAME card must still action (the reference learner: a second
    // thought about an already-flagged card was being silently dropped).
    act(() => { result.current.setFlagMessage('also the cloze is too easy'); });
    await act(async () => { result.current.handleFlagSubmit(); });
    expect(submitFlag).toHaveBeenCalledTimes(2);
    expect(submitFlag).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'c1', type: 'card', reason: 'Other', message: 'also the cloze is too easy',
    }));
  });

  it('clears pending and allows retry after a dropped (invalid) submit', async () => {
    submitFlag.mockResolvedValue('dropped');
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: noopRegister }));
    await act(async () => { result.current.handleFlagSubmit(); });
    expect(result.current.flagPending).toBe(false);
    await act(async () => { result.current.handleFlagSubmit(); });
    expect(submitFlag).toHaveBeenCalledTimes(2);
  });

  it('resets flagPending when the session advances to the next item', async () => {
    submitFlag.mockResolvedValue('queued');
    let reset: () => void = () => {};
    const register = (cb: () => void) => { reset = cb; return () => {}; };
    const { result } = renderHook(() => useFlagging({ item, registerResetCallback: register }));
    await act(async () => { result.current.handleFlagSubmit(); });
    expect(result.current.flagPending).toBe(true);
    act(() => { reset(); });
    expect(result.current.flagPending).toBe(false);
  });

  it('submits public flags by opaque delivery and retains the note for retry', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const publicItem = { id: 'canonical-card', type: 'card', deliveryId: 'delivery-1' };
    const { result } = renderHook(() => useFlagging({ item: publicItem, publicSurface: true, registerResetCallback: noopRegister }));
    act(() => { result.current.setFlagMode(true); result.current.setFlagMessage('Needs clearer labels'); });
    await act(async () => { await result.current.handleFlagSubmit(); });
    expect(result.current.flagMessage).toBe('Needs clearer labels');
    await act(async () => { await result.current.handleFlagSubmit(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).clientRequestId)
      .toBe(JSON.parse(fetchMock.mock.calls[1][1].body).clientRequestId);
    expect(result.current.flagged).toBe(true);
  });

  it('does not apply a late public flag result after the session advances', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((r) => { resolve = r; })));
    let reset: () => void = () => {};
    const register = (cb: () => void) => { reset = cb; return () => {}; };
    const { result } = renderHook(() => useFlagging({ item: { ...item, deliveryId: 'delivery-1' }, publicSurface: true, registerResetCallback: register }));
    act(() => { result.current.setFlagMode(true); result.current.setFlagMessage('Old card'); result.current.handleFlagSubmit(); });
    act(() => { reset(); });
    await act(async () => { resolve({ ok: true } as Response); });
    expect(result.current.flagged).toBe(false);
    expect(result.current.flagMode).toBe(false);
  });
});
