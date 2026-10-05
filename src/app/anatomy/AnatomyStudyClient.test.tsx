/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const testMocks = vi.hoisted(() => ({
  authStatus: 'unauthenticated' as 'authenticated' | 'unauthenticated',
  easeAfterExhaustion: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: testMocks.authStatus, data: null }) }));
vi.mock('@/hooks/useReviewDifficulty', () => ({
  useReviewDifficulty: (options: { onApplied?: () => void | Promise<void> }) => ({
    level: 0,
    pending: false,
    ready: false,
    error: null,
    adjustment: null,
    commit: vi.fn(),
    retry: vi.fn(),
    easeAfterExhaustion: (receipt: unknown) => {
      testMocks.easeAfterExhaustion(receipt);
      void options.onApplied?.();
    },
  }),
}));

import AnatomyStudyClient from './AnatomyStudyClient';

const question = (id: string) => ({
  deliveryId: id,
  stem: `Name structure ${id}.`,
  options: [
    { label: 'A', text: 'A structure' },
    { label: 'B', text: 'B structure' },
  ],
  domain: 'Anatomy',
  difficulty: 'easy',
  questionType: 'single-best-answer',
  attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
});
const answer = (id: string) => ({
  answer: {
    deliveryId: id,
    questionId: id,
    selectedDisplayLabel: 'A',
    correctDisplayLabel: 'A',
    isCorrect: true,
    attemptNumber: 1,
    explanation: 'Because.',
    postAnswerAlt: null,
    postAnswerSourcePageUrl: null,
    optionExplanations: [],
    attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
    citation: null,
  },
});
const card = (id: string) => ({
  deliveryId: id,
  kind: 'card' as const,
  front: `The [___] nerve abducts the eye (${id}).`,
  back: 'Abducens nerve',
  context: 'It supplies lateral rectus.',
  domain: 'Anatomy',
  attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
});
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });
const turn = (journeyId: string, items: unknown[], requestedSize = 1) => ({
  sessionId: journeyId,
  mode: 'daily',
  requestedSize,
  deliveredSize: items.length,
  items,
});

function profileResponse() {
  return json({ profile: { hookCompletedAt: 'now', explicit: { experience: 'undergrad' } } }) as Response;
}

describe('AnatomyStudyClient lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    testMocks.authStatus = 'unauthenticated';
    testMocks.easeAfterExhaustion.mockReset();
  });
  afterEach(() => cleanup());

  it('answers all three intro items, completes the hook, refreshes profile, then requests a normal turn', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    let profileReads = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/cohort/profile')) {
        if (init?.method === 'PATCH')
          return json({ profile: { hookCompletedAt: 'now', explicit: { experience: 'medical-student' } } }) as Response;
        return json({
          profile:
            profileReads++ === 0
              ? { hookCompletedAt: null, explicit: { experience: 'medical-student' } }
              : { hookCompletedAt: 'now', explicit: { experience: 'medical-student' } },
        }) as Response;
      }
      if (url.endsWith('/api/cohort/turn')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { nextDrawOrdinal?: number };
        const journeyId = (JSON.parse(String(init?.body ?? '{}')) as { journeyId: string }).journeyId;
        return json(
          body.nextDrawOrdinal === 3
            ? {
                sessionId: journeyId,
                mode: 'daily',
                requestedSize: 1,
                deliveredSize: 1,
                items: [question('daily')],
              }
            : {
                sessionId: journeyId,
                mode: 'daily',
                requestedSize: 3,
                deliveredSize: 3,
                items: [question('one'), question('two'), question('three')],
              },
        ) as Response;
      }
      if (url.endsWith('/api/cohort/answer'))
        return json(
          answer((JSON.parse(String(init?.body ?? '{}')) as { deliveryId?: string }).deliveryId ?? 'unknown'),
        ) as Response;
      throw new Error(`unexpected ${url}`);
    });
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    const user = userEvent.setup();
    render(<AnatomyStudyClient />);
    for (const id of ['one', 'two', 'three']) {
      await screen.findByText(`Name structure ${id}.`);
      await user.click(screen.getByRole('button', { name: /A\. A structure/ }));
      await user.click(screen.getByRole('button', { name: /Good \(3\)/ }));
      await user.click(await screen.findByRole('button', { name: 'Next' }));
    }
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => init?.method === 'PATCH' && String(init.body).includes('hookCompleted'),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('Name structure daily.')).toBeInTheDocument();
  });

  it('offers an introduction retry when the first turn fails after profile load', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    let turns = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/cohort/profile'))
        return json({ profile: { hookCompletedAt: null, explicit: { experience: 'undergrad' } } }) as Response;
      if (url.endsWith('/api/cohort/turn')) {
        turns += 1;
        if (turns === 1) return json({ error: 'temporary' }, false) as Response;
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        return json(
          turn(body.journeyId, [question('retry-one'), question('retry-two'), question('retry-three')], 3),
        ) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    const user = userEvent.setup();
    render(<AnatomyStudyClient />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry introduction' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Retry introduction' }));
    expect(await screen.findByText('Name structure retry-one.')).toBeInTheDocument();
    expect(turns).toBe(2);
  });

  it('retries a failed card grade with the identical request body', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    let grades = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/cohort/profile')) return profileResponse();
      if (url.endsWith('/api/cohort/turn')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        return json(turn(body.journeyId, [card('grade-card')])) as Response;
      }
      if (url.endsWith('/api/cohort/card-grade')) {
        grades += 1;
        return json(grades === 1 ? { error: 'temporary' } : { ok: true }, grades !== 1) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    const user = userEvent.setup();
    render(<AnatomyStudyClient />);
    await user.click(await screen.findByRole('button', { name: 'Show answer' }));
    await user.click(screen.getByRole('button', { name: /Good \(3\)/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/grade could not be saved/i));
    await user.click(screen.getByRole('button', { name: /Good \(3\)/ }));
    await waitFor(() => expect(grades).toBe(2));
    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/api/cohort/card-grade'))
      .map(([, init]) => init?.body);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('does not duplicate a saved grade when the next turn fails', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    let turns = 0;
    let grades = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/cohort/profile')) return profileResponse();
      if (url.endsWith('/api/cohort/turn')) {
        turns += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        if (turns === 2) return json({ error: 'temporary' }, false) as Response;
        return json(turn(body.journeyId, [card(turns === 1 ? 'saved-card' : 'next-card')])) as Response;
      }
      if (url.endsWith('/api/cohort/card-grade')) {
        grades += 1;
        return json({ ok: true }) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    const user = userEvent.setup();
    render(<AnatomyStudyClient />);
    await user.click(await screen.findByRole('button', { name: 'Show answer' }));
    await user.click(screen.getByRole('button', { name: /Good \(3\)/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry next item' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Good \(3\)/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry next item' }));
    await waitFor(() => expect(screen.getByText(/next-card/)).toBeInTheDocument());
    expect(grades).toBe(1);
    expect(turns).toBe(3);
  });

  it('automatically eases a hard exhaustion response and fetches a replacement turn', async () => {
    testMocks.authStatus = 'authenticated';
    const fetchMock = vi.spyOn(global, 'fetch');
    let turns = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/cohort/profile')) return profileResponse();
      if (url.endsWith('/api/cohort/turn')) {
        turns += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        return turns === 1
          ? (json({
              ...turn(body.journeyId, [], 1),
              reviewChallengeExhausted: { level: 2, revision: 4, policy: 'review-challenge-v2' },
            }) as Response)
          : (json(turn(body.journeyId, [card('eased-card')])) as Response);
      }
      if (url.endsWith('/api/cohort/difficulty')) return json({ level: 1, revision: 5 }) as Response;
      throw new Error(`unexpected ${url}`);
    });
    render(<AnatomyStudyClient />);
    await waitFor(() => expect(testMocks.easeAfterExhaustion).toHaveBeenCalled());
    expect(await screen.findByText(/eased-card/)).toBeInTheDocument();
    expect(turns).toBe(2);
  });

  it('rejects malformed question options before displaying the item', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/cohort/profile')) return profileResponse();
      if (url.endsWith('/api/cohort/turn')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        return json(
          turn(body.journeyId, [{ ...question('bad'), options: [{ label: '', text: 'unsafe' }] }]),
        ) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    render(<AnatomyStudyClient />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unsafe content/i));
    expect(screen.queryByText('Name structure bad.')).toBeNull();
  });
});
