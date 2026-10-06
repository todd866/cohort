/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const testMocks = vi.hoisted(() => ({
  authStatus: 'unauthenticated' as 'authenticated' | 'unauthenticated',
  easeAfterExhaustion: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: testMocks.authStatus, data: null }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/anatomy', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useReviewDifficulty', () => ({
  useReviewDifficulty: (options: { onApplied?: () => void | Promise<void> }) => ({
    level: 0,
    revision: 4,
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
import { CohortHostProvider } from '@/components/CohortHostContext';

function renderAnatomyStudyClient() {
  return render(
    <CohortHostProvider isCohortHost>
      <AnatomyStudyClient />
    </CohortHostProvider>,
  );
}

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
const media = {
  figureId: 'abducens-local' as const,
  target: 'lateral-rectus' as const,
  role: 'prompt' as const,
  preAnswerAlt: 'Prompt anatomy figure',
  postAnswerAlt: 'Answer anatomy figure',
};
const json = (body: unknown, ok = true) => new Response(JSON.stringify(body), {
  status: ok ? 200 : 503,
  headers: { 'Content-Type': 'application/json' },
});
const turn = (journeyId: string, items: unknown[], requestedSize = 1) => ({
  sessionId: journeyId,
  mode: 'daily',
  requestedSize,
  deliveredSize: items.length,
  items,
});

function profileResponse() {
  return json({ profile: { hookCompletedAt: 'now', explicit: { experience: 'undergrad' } }, deep: false, searchTopics: [{ id: 'module-anatomy', label: 'Anatomy', aliases: [], searchIntents: [], learningOutcomes: [], modalities: ['text'], eligibleItemCount: 1, eligibleAssetCount: 0 }], demandTopics: [] }) as Response;
}

describe('AnatomyStudyClient lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    configure({ asyncUtilTimeout: 5000 });
    testMocks.authStatus = 'unauthenticated';
    testMocks.easeAfterExhaustion.mockReset();
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: vi.fn(async () => undefined) });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:anatomy-figure') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    let requestSequence = 0;
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: vi.fn(() => `test-request-${++requestSequence}`) });
  });
  afterEach(() => { cleanup(); configure({ asyncUtilTimeout: 1000 }); });

  it('starts a first guest directly on one anatomy card without an experience gate', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/bootstrap')) return json({ ok: true }) as Response;
      if (url.endsWith('/api/cohort/profile')) return json({ profile: { hookCompletedAt: null, explicit: {} }, deep: false, searchTopics: [{ id: 'module-anatomy', label: 'Anatomy', aliases: [], searchIntents: [], learningOutcomes: [], modalities: ['text'], eligibleItemCount: 1, eligibleAssetCount: 0 }], demandTopics: [] }) as Response;
      if (url.endsWith('/api/cohort/turn')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string; nextDrawOrdinal?: number };
        expect(body.nextDrawOrdinal).toBe(0);
        return json(turn(body.journeyId, [card('first')], 1)) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    renderAnatomyStudyClient();
    expect(await screen.findByText(/The/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /study level/i })).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/cohort/turn'))).toHaveLength(1);
  });

  it('offers a retry when the first anatomy turn fails after profile load', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    let turns = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/bootstrap')) return json({ ok: true }) as Response;
      if (url.endsWith('/api/cohort/profile'))
        return json({ profile: { hookCompletedAt: null, explicit: { experience: 'undergrad' } }, deep: false, searchTopics: [{ id: 'module-anatomy', label: 'Anatomy', aliases: [], searchIntents: [], learningOutcomes: [], modalities: ['text'], eligibleItemCount: 1, eligibleAssetCount: 0 }], demandTopics: [] }) as Response;
      if (url.endsWith('/api/cohort/turn')) {
        turns += 1;
        if (turns <= 2) return json({ error: 'temporary' }, false) as Response;
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        return json(turn(body.journeyId, [card('retry-one')], 1)) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    const user = userEvent.setup();
    renderAnatomyStudyClient();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/retry-one/)).toBeInTheDocument();
    expect(turns).toBe(3);
  });

  it('retries a failed card grade with the identical request body', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    let grades = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/bootstrap')) return json({ ok: true }) as Response;
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
    renderAnatomyStudyClient();
    await user.click(await screen.findByRole('button', { name: /Show answer/ }));
    await user.click(screen.getByRole('button', { name: /Good \(3\)/ }));
    await waitFor(() => expect(grades).toBe(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Good \(3\)/ })).toBeEnabled());
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
      if (url.endsWith('/api/session/bootstrap')) return json({ ok: true }) as Response;
      if (url.endsWith('/api/cohort/profile')) return profileResponse();
      if (url.endsWith('/api/cohort/turn')) {
        turns += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        if (turns === 2 || turns === 3) return json({ error: 'temporary' }, false) as Response;
        return json(turn(body.journeyId, [card(turns === 1 ? 'saved-card' : 'next-card')])) as Response;
      }
      if (url.endsWith('/api/cohort/card-grade')) {
        grades += 1;
        return json({ ok: true }) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    const user = userEvent.setup();
    renderAnatomyStudyClient();
    await user.click(await screen.findByRole('button', { name: /Show answer/ }));
    await user.click(screen.getByRole('button', { name: /Good \(3\)/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(screen.getByText(/next-card/)).toBeInTheDocument());
    expect(grades).toBe(1);
    expect(turns).toBe(4);
  });

  it('automatically eases a hard exhaustion response and fetches a replacement turn', async () => {
    testMocks.authStatus = 'authenticated';
    const fetchMock = vi.spyOn(global, 'fetch');
    let turns = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/bootstrap')) return json({ ok: true }) as Response;
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
    renderAnatomyStudyClient();
    await waitFor(() => expect(testMocks.easeAfterExhaustion).toHaveBeenCalled());
    expect(await screen.findByText(/eased-card/)).toBeInTheDocument();
    expect(turns).toBe(2);
  });

  it('rejects malformed question options before displaying the item', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/bootstrap')) return json({ ok: true }) as Response;
      if (url.endsWith('/api/cohort/profile')) return profileResponse();
      if (url.endsWith('/api/cohort/turn')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        return json(
          turn(body.journeyId, [{ ...question('bad'), options: [{ label: '', text: 'unsafe' }] }]),
        ) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    renderAnatomyStudyClient();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Invalid study question|unsafe item/i));
    expect(screen.queryByText('Name structure bad.')).toBeNull();
  });

  it('rejects a malformed anatomy media descriptor before displaying the card', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/bootstrap')) return json({ ok: true }) as Response;
      if (url.endsWith('/api/cohort/profile')) return profileResponse();
      if (url.endsWith('/api/cohort/turn')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        const malformed = { ...card('bad-media'), media: { ...media, target: undefined } };
        return json(turn(body.journeyId, [malformed])) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    renderAnatomyStudyClient();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Invalid study card|unsafe item/i));
    expect(screen.queryByText(/bad-media/)).toBeNull();
  });

  it('does not allow reveal until the reviewed prompt figure is loaded and passes its target', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/bootstrap')) return json({ ok: true }) as Response;
      if (url.endsWith('/api/cohort/profile')) return profileResponse();
      if (url.startsWith('/api/anatomy/abducens')) return { ok: true, status: 200, blob: async () => new Blob(['figure'], { type: 'image/svg+xml' }) } as Response;
      if (url.endsWith('/api/cohort/turn')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { journeyId: string };
        return json(turn(body.journeyId, [{ ...card('visual-card'), media }])) as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    const user = userEvent.setup();
    renderAnatomyStudyClient();
    const figure = await screen.findByAltText('Prompt anatomy figure');
    const reveal = await screen.findByRole('button', { name: /Show answer/ });
    expect(reveal).toBeEnabled();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/anatomy/abducens?target=lateral-rectus&phase=prompt')).toBe(true);
    expect(figure).toHaveAttribute('data-source', '/api/anatomy/abducens?target=lateral-rectus&phase=prompt');
    await user.click(reveal);
    expect(await screen.findByAltText('Answer anatomy figure')).toHaveAttribute(
      'data-source',
      '/api/anatomy/abducens?target=lateral-rectus&phase=answer',
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/anatomy/abducens?target=lateral-rectus&phase=answer')).toBe(true);
  });
});
