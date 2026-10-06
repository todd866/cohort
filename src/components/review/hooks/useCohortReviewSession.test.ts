/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useReviewSession } from './useReviewSession';

vi.mock('@/hooks/useActiveModules', () => ({
  useActiveModules: () => ({ activeModules: [] }),
}));
vi.mock('@/lib/review-queue', () => ({
  flushReviewQueue: vi.fn().mockResolvedValue(undefined),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

const mockFetch = vi.fn();
const question = (deliveryId: string) => ({
  deliveryId, stem: `Stem ${deliveryId}`,
  options: ['A', 'B', 'C', 'D'].map((label) => ({ label, text: `Option ${label}` })),
  domain: 'Paediatrics', difficulty: 'medium', questionType: 'management',
  attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
});
const card = {
  deliveryId: 'card-delivery-1', kind: 'card', front: 'The first-line treatment for croup is oral [___].',
  back: 'dexamethasone', context: 'A single dose reduces return visits.', domain: 'Paediatrics',
  attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
};
function turn(sessionId: string, items: unknown[]) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
    sessionId, mode: 'daily', requestedSize: items.length, deliveredSize: items.length, items,
  }) };
}
const cardTurn = {
  sessionId: 'journey-cards', mode: 'daily', requestedSize: 1, deliveredSize: 1,
  items: [card],
};
const questionTurn = {
  sessionId: 'journey-cards', mode: 'daily', requestedSize: 1, deliveredSize: 1,
  items: [question('question-delivery-2')],
};
beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = mockFetch;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('public Cohort review session', () => {
  it('keeps a module card visible while the acknowledged next turn loads', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== '/api/cohort/turn') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      calls += 1;
      if (calls === 1) return Promise.resolve(turn('journey-cards', [card]));
      return gate.then(() => turn('journey-cards', [question('question-delivery-2')]));
    });
    const { result } = renderHook(() => useReviewSession({ rotations: ['usmle-step1-open'], singleTurn: true, cohortTurn: { journeyId: 'journey-cards', searchTopicId: 'module-paeds' } }));
    await waitFor(() => expect(result.current.currentItem?.id).toBe('card-delivery-1'));
    let next!: Promise<void>;
    act(() => { next = result.current.advanceAndRefresh(); });
    await waitFor(() => expect(result.current.refreshingNext).toBe(true));
    expect(result.current.currentItem?.id).toBe('card-delivery-1');
    act(() => release());
    await act(async () => { await next; });
    expect(result.current.currentItem?.id).toBe('question-delivery-2');
  });

  it('prepares an acknowledged MCQ successor, then consumes it on Continue without a second POST', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== '/api/cohort/turn') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls += 1;
      return Promise.resolve(turn('journey-prep', [question(calls === 1 ? 'current' : 'next')]));
    });
    const { result } = renderHook(() => useReviewSession({ rotations: ['usmle-step1-open'], singleTurn: true, cohortTurn: { journeyId: 'journey-prep', searchTopicId: null } }));
    await waitFor(() => expect(result.current.currentItem?.id).toBe('current'));
    let preparation!: Promise<void>;
    act(() => { preparation = result.current.prepareNextCohortTurn(); });
    await act(async () => { await Promise.all([preparation, result.current.advanceAndRefresh()]); });
    expect(result.current.currentItem?.id).toBe('next');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ nextDrawOrdinal: 1, previousDeliveryId: 'current' });
  });

  it('consumes a supplied reserved turn without fetching it again', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== '/api/cohort/turn') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(turn('journey-supplied', [question(bodies.length === 1 ? 'current' : 'unexpected-fetch')]));
    });
    const { result } = renderHook(() => useReviewSession({ rotations: ['usmle-step1-open'], singleTurn: true, cohortTurn: { journeyId: 'journey-supplied', searchTopicId: null } }));
    await waitFor(() => expect(result.current.currentItem?.id).toBe('current'));
    const request = result.current.reserveNextCohortTurn('current');
    expect(request).toMatchObject({ journeyId: 'journey-supplied', previousDeliveryId: 'current', nextDrawOrdinal: 1 });
    await act(async () => {
      await result.current.prepareNextCohortTurn({
        request: request!,
        response: { sessionId: 'journey-supplied', mode: 'daily', requestedSize: 1, deliveredSize: 1, items: [question('supplied')] },
      });
      await result.current.advanceAndRefresh();
    });
    expect(result.current.currentItem?.id).toBe('supplied');
    expect(bodies).toHaveLength(1);
  });

  it('replays the same prepared receipt after media preparation failure', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const figure = await import('@/components/shared/AnatomyReviewFigure');
    vi.spyOn(figure, 'prepareAnatomyFigure').mockRejectedValueOnce(new Error('media unavailable')).mockResolvedValue({} as never);
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== '/api/cohort/turn') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls += 1;
      const media = calls > 1 ? { figureId: 'abducens-local', target: 'lateral-rectus', role: 'prompt', preAnswerAlt: 'Eye muscle diagram', postAnswerAlt: 'Lateral rectus diagram' } : undefined;
      return Promise.resolve(turn('journey-media', [{ ...(calls === 1 ? card : { ...card, deliveryId: 'next' }), ...(media ? { media } : {}) }]));
    });
    const { result } = renderHook(() => useReviewSession({ rotations: ['usmle-step1-open'], singleTurn: true, cohortTurn: { journeyId: 'journey-media', searchTopicId: null } }));
    await waitFor(() => expect(result.current.currentItem?.id).toBe('card-delivery-1'));
    await act(async () => { await result.current.advanceAndRefresh(); });
    expect(result.current.currentItem?.id).toBe('next');
    expect(new Set(bodies.slice(1).map((body) => body.serveRequestId)).size).toBe(1);
  });

  it('lets Continue await a delayed preparation failure, then retries the same receipt', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    let rejectPreparation!: () => void;
    const figure = await import('@/components/shared/AnatomyReviewFigure');
    vi.spyOn(figure, 'prepareAnatomyFigure').mockImplementationOnce(() => new Promise((_, reject) => { rejectPreparation = () => reject(new Error('media unavailable')); })).mockResolvedValue({} as never);
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== '/api/cohort/turn') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls += 1;
      const media = calls > 1 ? { figureId: 'abducens-local', target: 'lateral-rectus', role: 'prompt', preAnswerAlt: 'Eye muscle diagram', postAnswerAlt: 'Lateral rectus diagram' } : undefined;
      return Promise.resolve(turn('journey-race', [{ ...(calls === 1 ? card : { ...card, deliveryId: 'next' }), ...(media ? { media } : {}) }]));
    });
    const { result } = renderHook(() => useReviewSession({ rotations: ['usmle-step1-open'], singleTurn: true, cohortTurn: { journeyId: 'journey-race', searchTopicId: null } }));
    await waitFor(() => expect(result.current.currentItem?.id).toBe('card-delivery-1'));
    let next!: Promise<void>;
    act(() => { next = result.current.advanceAndRefresh(); });
    await waitFor(() => expect(rejectPreparation).toBeTypeOf('function'));
    act(() => rejectPreparation());
    await act(async () => { await next; });
    expect(result.current.currentItem?.id).toBe('next');
    expect(new Set(bodies.slice(1).map((body) => body.serveRequestId)).size).toBe(1);
  });

  it('does not let a prepared response from an old journey replace the new scope', async () => {
    let releasePreparation!: (response: ReturnType<typeof turn>) => void;
    let calls = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url !== '/api/cohort/turn') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      calls += 1;
      if (calls === 1) return Promise.resolve(turn('journey-scope-a', [question('scope-a-current')]));
      if (calls === 2) return new Promise((resolve) => { releasePreparation = resolve; });
      return Promise.resolve(turn('journey-scope-b', [question('scope-b-current')]));
    });
    const { result, rerender } = renderHook(
      ({ journeyId }) => useReviewSession({ rotations: ['usmle-step1-open'], singleTurn: true, cohortTurn: { journeyId, searchTopicId: null } }),
      { initialProps: { journeyId: 'journey-scope-a' } },
    );
    await waitFor(() => expect(result.current.currentItem?.id).toBe('scope-a-current'));
    let preparation!: Promise<void>;
    act(() => {
      result.current.reserveNextCohortTurn('scope-a-current');
      preparation = result.current.prepareNextCohortTurn();
    });
    rerender({ journeyId: 'journey-scope-b' });
    await waitFor(() => expect(result.current.currentItem?.id).toBe('scope-b-current'));
    releasePreparation(turn('journey-scope-a', [question('scope-a-next')]));
    await act(async () => { await preparation.catch(() => undefined); });
    expect(result.current.currentItem?.id).toBe('scope-b-current');
  });

  it('saves difficulty without drawing past the ungraded module card', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== '/api/cohort/turn') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(turn('journey-cards', bodies.length === 1 ? cardTurn.items : questionTurn.items));
    });
    const { result } = renderHook(() => useReviewSession({ rotations: ['usmle-step1-open'], singleTurn: true, cohortTurn: { journeyId: 'journey-cards', searchTopicId: 'module-paeds' } }));
    await waitFor(() => expect(result.current.currentItem?.id).toBe('card-delivery-1'));
    await act(async () => { await result.current.refreshForChallenge(4); });
    expect(bodies).toHaveLength(1);
    await act(async () => { await result.current.advanceAndRefresh(); });
    expect(bodies[1]).toMatchObject({ nextDrawOrdinal: 1, previousDeliveryId: 'card-delivery-1' });
    expect(result.current.currentItem?.id).toBe('question-delivery-2');
  });

  it('consumes and reports a confirmed hard exhaustion receipt before easing', async () => {
    const receipt = { level: 2, revision: 4, policy: 'review-challenge-v2' };
    const exhausted = vi.fn();
    let calls = 0;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== '/api/cohort/turn') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      calls += 1;
      const payload = calls === 1 ? cardTurn : calls === 2
        ? { ...cardTurn, deliveredSize: 0, items: [], reviewChallengeExhausted: receipt }
        : questionTurn;
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload });
    });
    const { result } = renderHook(() => useReviewSession({ rotations: ['usmle-step1-open'], singleTurn: true, reviewChallengeRevision: 4, onChallengeExhausted: exhausted, cohortTurn: { journeyId: 'journey-cards', searchTopicId: 'module-paeds' } }));
    await waitFor(() => expect(result.current.currentItem?.id).toBe('card-delivery-1'));
    await act(async () => { await result.current.advanceAndRefresh(); });
    await waitFor(() => expect(exhausted).toHaveBeenCalledWith(receipt));
    expect(result.current.items).toEqual([]);
    await act(async () => { await result.current.refreshForChallenge(5); });
    expect(result.current.currentItem?.id).toBe('question-delivery-2');
    expect(exhausted).toHaveBeenCalledTimes(1);
  });

  it('refuses a module card carrying fields outside its public contract', async () => {
    mockFetch.mockImplementation((url: string) => (url === '/api/cohort/turn'
      ? Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ...cardTurn, items: [{ ...card, cardId: 'private-id' }] }) })
      : Promise.resolve({ ok: true, status: 200, json: async () => ({}) })));
    const { result } = renderHook(() => useReviewSession({ rotations: ['usmle-step1-open'], singleTurn: true, cohortTurn: { journeyId: 'journey-cards', searchTopicId: 'module-paeds' } }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(result.current.items).toEqual([]);
  });
});
