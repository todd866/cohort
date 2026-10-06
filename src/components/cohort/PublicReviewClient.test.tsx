/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicReviewClient } from './PublicReviewClient';
import { parseCohortCardSessionItem } from '@/lib/cohort/card-turn-contract';
import type { PublicReviewProfile } from './PublicReviewEntry';

const mocks = vi.hoisted(() => ({ push: vi.fn(), fetch: vi.fn(), prepareFigure: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: 'unauthenticated', data: null }) }));
vi.mock('@/lib/client-request-id', () => ({ genClientRequestId: () => 'journey-1' }));
vi.mock('@/components/shared/useReviewKeyboard', () => ({ useReviewKeyboard: () => {} }));
vi.mock('@/components/shared/AnatomyReviewFigure', () => ({ AnatomyReviewFigure: () => <div data-testid="figure" />, prepareAnatomyFigure: mocks.prepareFigure }));
vi.mock('./PublicReviewFeedback', () => ({ PublicReviewFeedback: () => null }));
vi.mock('@/components/shared/ReviewModulePicker', () => ({ ReviewModulePicker: () => null }));
vi.mock('@/components/shared/ReviewDifficultyControl', () => ({ ReviewDifficultyControl: () => null }));
vi.mock('@/hooks/useReviewDifficulty', () => ({ useReviewDifficulty: () => ({ level: 0.5, commit: vi.fn(), pending: false, ready: true, adjustment: null, error: null, retry: vi.fn(), easeAfterExhaustion: vi.fn() }) }));

const profile: PublicReviewProfile = {
  profile: { hookCompletedAt: '2026-10-01T00:00:00.000Z', explicit: { experience: 'medical-student' } },
  deep: false,
  searchTopics: [],
  demandTopics: [],
};
const item = {
  deliveryId: 'delivery-1', stem: 'Which mechanism?',
  options: [{ label: 'A', text: 'First option' }, { label: 'B', text: 'Second option' }],
  domain: 'module-test', difficulty: 'medium', questionType: 'mechanism',
  attribution: { text: 'Contributors', licence: 'CC-BY-4.0' },
};
const answer = {
  answer: {
    deliveryId: 'delivery-1', questionId: 'question-1', selectedDisplayLabel: 'B', correctDisplayLabel: 'A',
    isCorrect: false, attemptNumber: 1, explanation: 'The first mechanism is supported.', postAnswerAlt: null,
    postAnswerSourcePageUrl: null, optionExplanations: [], attribution: item.attribution, citation: null,
  },
};
const cardItem = {
  deliveryId: 'card-1', kind: 'card' as const, front: 'The [___] nerve abducts the eye.', back: 'abducens', context: 'It innervates lateral rectus.',
  domain: 'module-anatomy', attribution: { text: 'Contributors', licence: 'CC-BY-4.0' },
};
const mediaCardItem = { ...cardItem, deliveryId: 'card-2', media: { figureId: 'abducens-local', target: 'abducens', role: 'prompt', preAnswerAlt: 'A nerve diagram', postAnswerAlt: 'The abducens nerve', } };

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('PublicReviewClient', () => {
  beforeEach(() => {
    mocks.push.mockReset();
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockResolvedValueOnce(response({ sessionId: 'journey-1', mode: 'daily', requestedSize: 1, deliveredSize: 1, items: [item] }));
    mocks.prepareFigure.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not advance or grade before an MCQ confidence submission', async () => {
    mocks.fetch.mockResolvedValueOnce(response(answer));
    render(<PublicReviewClient topicId={null} snapshot={profile} onProfile={vi.fn()} />);
    await screen.findByText('Which mechanism?');
    fireEvent.click(screen.getByRole('button', { name: /B\. Second option/i }));
    expect(screen.getByRole('button', { name: /Good \(3\)/i })).toBeInTheDocument();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Incorrect' })).toBeInTheDocument());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(mocks.fetch.mock.calls[1][1].body))).toMatchObject({ deliveryId: 'delivery-1', selectedDisplayLabel: 'B', confidence: 3 });
  });

  it('keeps the same answer payload when the first grade write fails and retry is used', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('write lost'));
    mocks.fetch.mockResolvedValueOnce(response(answer));
    render(<PublicReviewClient topicId={null} snapshot={profile} onProfile={vi.fn()} />);
    await screen.findByText('Which mechanism?');
    fireEvent.click(screen.getByRole('button', { name: /A\. First option/i }));
    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Incorrect' })).toBeInTheDocument());
    const writes = mocks.fetch.mock.calls.filter(([url]) => url === '/api/cohort/answer');
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[0][1].body).toBe(writes[1][1].body);
  });

  it('does not issue a turn while the completed-hook profile still lacks experience', async () => {
    mocks.fetch.mockReset();
    const gatedProfile = { ...profile, profile: { hookCompletedAt: profile.profile.hookCompletedAt, explicit: {} } };
    render(<PublicReviewClient topicId={null} snapshot={gatedProfile} onProfile={vi.fn()} />);
    await waitFor(() => expect(mocks.fetch).not.toHaveBeenCalled());
  });

  it('grades a card durably before requesting the next turn', async () => {
    mocks.fetch.mockReset()
      .mockResolvedValueOnce(response({ sessionId: 'journey-1', mode: 'daily', requestedSize: 1, deliveredSize: 1, items: [cardItem] }))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ sessionId: 'journey-1', mode: 'daily', requestedSize: 1, deliveredSize: 0, items: [] }));
    render(<PublicReviewClient topicId={null} snapshot={profile} onProfile={vi.fn()} />);
    await screen.findByRole('button', { name: /Show answer/ });
    fireEvent.click(screen.getByRole('button', { name: /Show answer/ }));
    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/complete|preparing/i));
    const urls = mocks.fetch.mock.calls.map(([url]) => url);
    expect(urls).toEqual(['/api/cohort/turn', '/api/cohort/card-grade', '/api/cohort/turn']);
  });

  it('keeps the answered card visible when preparation of the next card fails', async () => {
    expect(parseCohortCardSessionItem(mediaCardItem)).not.toBeNull();
    mocks.fetch.mockReset()
      .mockResolvedValueOnce(response({ sessionId: 'journey-1', mode: 'daily', requestedSize: 3, deliveredSize: 3, items: [cardItem, mediaCardItem, cardItem] }))
      .mockResolvedValueOnce(response({ ok: true }));
    mocks.prepareFigure.mockRejectedValue(new Error('decode failed'));
    render(<PublicReviewClient topicId={null} snapshot={profile} onProfile={vi.fn()} />);
    await screen.findByRole('button', { name: /Show answer/ });
    fireEvent.click(screen.getByRole('button', { name: /Show answer/ }));
    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/picture could not be prepared/i));
    expect(screen.getByText(/It innervates lateral rectus/)).toBeInTheDocument();
  });

  it('ignores a late turn response after unmount', async () => {
    mocks.fetch.mockReset();
    let resolveTurn!: (value: Response) => void;
    const late = new Promise<Response>((resolve) => { resolveTurn = resolve; });
    mocks.fetch.mockReturnValueOnce(late);
    const view = render(<PublicReviewClient topicId={null} snapshot={profile} onProfile={vi.fn()} />);
    view.unmount();
    await act(async () => { resolveTurn(response({ sessionId: 'journey-1', mode: 'daily', requestedSize: 1, deliveredSize: 1, items: [item] })); });
    expect(screen.queryByText('Which mechanism?')).not.toBeInTheDocument();
  });
});

  it('completes a three-question first hook and persists completion after the final answer', async () => {
    const hookItems = ['hook-1', 'hook-2', 'hook-3'].map((deliveryId) => ({ ...item, deliveryId, stem: `Hook question ${deliveryId}` }));
    const profilePatch = vi.fn();
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (url, init) => {
      const endpoint = String(url);
      if (endpoint.endsWith('/api/cohort/turn')) {
        return response({ sessionId: 'journey-1', mode: 'daily', requestedSize: 3, deliveredSize: 3, items: hookItems });
      }
      if (endpoint.endsWith('/api/cohort/answer')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { deliveryId: string };
        return response({ answer: { ...answer.answer, deliveryId: body.deliveryId, questionId: body.deliveryId } });
      }
      if (endpoint.endsWith('/api/cohort/profile') && init?.method === 'PATCH') {
        profilePatch(JSON.parse(String(init.body)));
        return response({ profile: { hookCompletedAt: '2026-10-06T00:00:00.000Z', explicit: {} } });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', mocks.fetch);
    render(<PublicReviewClient topicId={null} snapshot={{ ...profile, profile: { hookCompletedAt: null, explicit: {} } }} onProfile={vi.fn()} />);
    await screen.findByText('Hook question hook-1');
    for (const deliveryId of ['hook-1', 'hook-2', 'hook-3']) {
      fireEvent.click(screen.getByRole('button', { name: /A\. First option/i }));
      fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));
      await waitFor(() => expect(screen.getByRole('status', { name: 'Incorrect' })).toBeInTheDocument());
      if (deliveryId !== 'hook-3') fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      if (deliveryId !== 'hook-3') await screen.findByText(`Hook question ${deliveryId === 'hook-1' ? 'hook-2' : 'hook-3'}`);
    }
    await waitFor(() => expect(profilePatch).toHaveBeenCalledWith({ hookCompleted: true }));
  });
