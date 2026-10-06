/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UnifiedReview } from './UnifiedReview';
import { CohortHostProvider } from '@/components/CohortHostContext';
import { reviewSessionScopeKey } from '@/lib/review/session-scope';
import type { ReviewItem } from './hooks/types';

// Mock next-auth/react for useSession in useActiveModules
vi.mock('next-auth/react', async () => ({
  useSession: vi.fn(() => ({ data: null, status: 'unauthenticated' })),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  // Card views read the session context directly; no provider means no session.
  SessionContext: (await import('react')).createContext(undefined),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

/** Minimal valid daily-target response so useSessionProgress doesn't crash */
const DAILY_TARGET_RESPONSE = {
  dailyTarget: 20,
  coverage: { seen: 5, total: 100, percent: 5, seenCards: 3, totalCards: 60, seenQuestions: 2, totalQuestions: 40 },
  daysToExam: 10,
  examDate: '2026-03-06',
  todayReviewed: 5,
};

function setMatchMedia(matchesByQuery: Record<string, boolean>) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matchesByQuery[query] ?? false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('UnifiedReview (autoscroll)', () => {
  const scrollIntoViewMock = vi.fn();
  const scrollByMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset(); // Reset implementation completely
    localStorage.clear(); // Clear localStorage to prevent cache from previous tests

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    scrollByMock.mockReset();
    Object.defineProperty(window, 'scrollBy', {
      configurable: true,
      writable: true,
      value: scrollByMock,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 800,
    });

    // Post-answer peek only fires when the reveal head is below the usable
    // viewport. jsdom's default rect is all zeros (already "visible"), so
    // place .review-reveal below the fold for these tests.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList?.contains('review-reveal')) {
        return {
          top: 900, bottom: 2000, left: 0, right: 400, width: 400, height: 1100,
          x: 0, y: 900, toJSON() { return this; },
        } as DOMRect;
      }
      return {
        top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0,
        x: 0, y: 0, toJSON() { return this; },
      } as DOMRect;
    });

    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('peeks the MCQ explanation after answering, then scrolls to top on next (coarse pointer)', async () => {
    setMatchMedia({
      '(pointer: coarse)': true,
      '(prefers-reduced-motion: reduce)': false,
    });

    let sessionGetCalls = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/api/study/daily-target')) {
        return { ok: true, json: async () => DAILY_TARGET_RESPONSE };
      }

      if (url.startsWith('/api/study/unified-session') && !init?.method) {
        sessionGetCalls += 1;
        if (sessionGetCalls === 1) {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  type: 'question',
                  id: 'q1',
                  stem: 'First question stem',
                  options: [
                    { label: 'A', text: 'Option A', isCorrect: true },
                    { label: 'B', text: 'Option B', isCorrect: false },
                  ],
                  context: 'Because A.',
                  rotation: 'critical-care',
                },
                {
                  type: 'question',
                  id: 'q2',
                  stem: 'Second question stem',
                  options: [
                    { label: 'A', text: 'Option A2', isCorrect: false },
                    { label: 'B', text: 'Option B2', isCorrect: true },
                  ],
                  context: 'Because B.',
                  rotation: 'critical-care',
                },
              ],
            }),
          };
        }

        return { ok: true, json: async () => ({ items: [] }) };
      }

      return { ok: true, json: async () => ({}) };
    });

    render(<UnifiedReview rotations={["critical-care"]} />);

    await screen.findByText('First question stem');
    expect(screen.queryByRole('heading', { name: 'USMLE Step 1 practice' })).toBeNull();
    expect(scrollByMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Option A/i }));
    await screen.findByRole('status', { name: 'Correct' });
    await screen.findByRole('button', { name: /Again \(1\)/i });

    await waitFor(() => {
      expect(scrollByMock).toHaveBeenCalledTimes(1);
    });

    await userEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));

    await waitFor(() => {
      // Advance resets to top via scrollIntoView (instant), not scrollBy.
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    });

    await screen.findByText('Second question stem');
  });

  // Behaviour change 2026-07-09 (the reference learner): the post-answer scroll to the
  // context/figure used to be gated on `(pointer: coarse)`, so it never fired on
  // the desktop where most reviewing happens. It now runs on every pointer type;
  // `prefers-reduced-motion` downgrades the behaviour to 'auto' rather than
  // skipping the scroll.
  it('peeks the explanation on a fine pointer (desktop) too', async () => {
    setMatchMedia({
      '(pointer: coarse)': false,
      '(prefers-reduced-motion: reduce)': false,
    });

    // Mock all fetch calls to return the same data
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/api/study/daily-target')) {
        return { ok: true, json: async () => DAILY_TARGET_RESPONSE };
      }

      // API fetch - return data
      if (url.includes('/api/study/unified-session')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                type: 'question',
                id: 'q1',
                stem: 'Question stem',
                options: [
                  { label: 'A', text: 'Option A', isCorrect: true },
                  { label: 'B', text: 'Option B', isCorrect: false },
                ],
                context: 'Because A.',
                rotation: 'critical-care',
              },
            ],
          }),
        };
      }

      return { ok: true, json: async () => ({}) };
    });

    render(<UnifiedReview rotations={["critical-care"]} />);

    await screen.findByText('Question stem');
    await userEvent.click(screen.getByRole('button', { name: /Option A/i }));
    await screen.findByRole('button', { name: /Again \(1\)/i });

    await waitFor(() => {
      expect(scrollByMock).toHaveBeenCalledTimes(1);
    });
  });

  it('does not yank when the reveal head is already on screen', async () => {
    setMatchMedia({
      '(pointer: coarse)': false,
      '(prefers-reduced-motion: reduce)': false,
    });

    // Head already visible — only a tall tail would have triggered the old
    // full-rect isOffscreen gate.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList?.contains('review-reveal')) {
        return {
          top: 400, bottom: 2000, left: 0, right: 400, width: 400, height: 1600,
          x: 0, y: 400, toJSON() { return this; },
        } as DOMRect;
      }
      return {
        top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0,
        x: 0, y: 0, toJSON() { return this; },
      } as DOMRect;
    });

    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url.includes('/api/study/unified-session')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                type: 'question',
                id: 'q1',
                stem: 'Question stem',
                options: [
                  { label: 'A', text: 'Option A', isCorrect: true },
                  { label: 'B', text: 'Option B', isCorrect: false },
                ],
                context: 'Because A.',
                rotation: 'critical-care',
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<UnifiedReview rotations={["critical-care"]} />);

    await screen.findByText('Question stem');
    await userEvent.click(screen.getByRole('button', { name: /Option A/i }));
    await screen.findByRole('status', { name: 'Correct' });

    // Give the rAF scroll effect a turn; it must no-op.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Again \(1\)/i })).toBeInTheDocument();
    });
    expect(scrollByMock).not.toHaveBeenCalled();
  });

  it("normalizes MDX angle-bracket escapes in MCQ text", async () => {
    setMatchMedia({
      '(pointer: coarse)': false,
      '(prefers-reduced-motion: reduce)': false,
    });

    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/api/study/daily-target')) {
        return { ok: true, json: async () => DAILY_TARGET_RESPONSE };
      }

      // API fetch - return data
      if (url.includes('/api/study/unified-session')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                type: 'question',
                id: 'q1',
                stem: "When should you transfuse?",
                options: [
                  { label: 'A', text: "Hb {'<'}70 g/L", isCorrect: true },
                  { label: 'B', text: "Hb {'>'}70 g/L", isCorrect: false },
                ],
                context: "Most stable ICU patients: Hb {'<'}70 g/L.",
                rotation: 'critical-care',
              },
            ],
          }),
        };
      }

      return { ok: true, json: async () => ({}) };
    });

    render(<UnifiedReview rotations={["critical-care"]} />);

    await screen.findByText('When should you transfuse?');
    // GlossaryText may split "Hb" into an <abbr> element, so match across elements
    expect(screen.getByText(/<70 g\/L/)).toBeInTheDocument();
    expect(screen.getByText(/>70 g\/L/)).toBeInTheDocument();
    expect(screen.queryByText(/\\{\\s*'\\s*<\\s*'\\s*\\}/)).toBeNull();
  });

  it('replaces opaque image reveal with confidence instructions before revealing', async () => {
    const item = {
      ...cohortQuestion('opaque-image-reveal', 'Choose the fixture answer'),
      rotation: 'critical-care',
      imageUrl: '/figures/fixture/explanation.svg',
    };
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url.includes('/api/study/unified-session')) {
        return { ok: true, json: async () => ({ items: [item] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    render(<UnifiedReview rotations={['critical-care']} />);
    await screen.findByText('Choose the fixture answer');
    await userEvent.click(screen.getByRole('button', { name: /Skip question/ }));
    expect(screen.getByRole('group', { name: 'When do you want to see this again?' })).toBeInTheDocument();
    expect(screen.getByText('how sure are you?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show answer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders per-option explanations as click-to-reveal after answering', async () => {
    setMatchMedia({
      '(pointer: coarse)': false,
      '(prefers-reduced-motion: reduce)': false,
    });

    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/api/study/daily-target')) {
        return { ok: true, json: async () => DAILY_TARGET_RESPONSE };
      }

      if (url.includes('/api/study/unified-session')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                type: 'question',
                id: 'q-opt-exp',
                stem: 'Best first-line pressor in septic shock?',
                options: [
                  {
                    label: 'A',
                    text: 'Noradrenaline',
                    isCorrect: true,
                    explanation: 'Correct: first-line vasopressor in septic shock.',
                  },
                  {
                    label: 'B',
                    text: 'Dopamine',
                    isCorrect: false,
                    explanation: 'Incorrect: higher arrhythmia risk than noradrenaline.',
                  },
                  {
                    label: 'C',
                    text: 'Phenylephrine',
                    isCorrect: false,
                  },
                ],
                context: 'Global explanation should still be shown.',
                rotation: 'critical-care',
              },
            ],
          }),
        };
      }

      return { ok: true, json: async () => ({}) };
    });

    render(<UnifiedReview rotations={["critical-care"]} />);

    await screen.findByText('Best first-line pressor in septic shock?');

    // Answer question first (pre-answer options are in sticky footer).
    await userEvent.click(screen.getByRole('button', { name: /Noradrenaline/i }));
    await screen.findByText(/Correct/i);

    // Per-option explanations are hidden by default.
    expect(screen.queryByText(/higher arrhythmia risk/i)).toBeNull();

    // Click a post-answer option to reveal its explanation.
    await userEvent.click(screen.getByRole('button', { name: /Dopamine/i }));
    expect(screen.getByText(/higher arrhythmia risk/i)).toBeInTheDocument();

    // Toggle closed on second click.
    await userEvent.click(screen.getByRole('button', { name: /Dopamine/i }));
    expect(screen.queryByText(/higher arrhythmia risk/i)).toBeNull();

    // Global explanation remains visible.
    expect(screen.getByText(/Global explanation should still be shown/i)).toBeInTheDocument();

    // Option without explanation has no reveal action.
    const phenylephrineButton = screen.getByRole('button', { name: /Phenylephrine/i });
    expect(phenylephrineButton).toBeDisabled();
  });
});

function cohortQuestion(id: string, stem: string, hook = false): ReviewItem {
  return {
    type: 'question',
    id,
    deliveryId: id,
    stem,
    options: [
      { label: 'A', text: `${stem} option A` },
      { label: 'B', text: `${stem} option B` },
      { label: 'C', text: `${stem} option C` },
      { label: 'D', text: `${stem} option D` },
    ],
    rotation: 'usmle-step1-open',
    ...(hook ? { decisionContext: { cohortHook: true } } : {}),
  };
}

function cohortAnswerResponse(deliveryId: string, selectedDisplayLabel: string | null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      deduped: false,
      answer: {
        deliveryId,
        selectedDisplayLabel,
        isCorrect: selectedDisplayLabel === 'A',
        correctDisplayLabel: 'A',
        explanation: `Explanation for ${deliveryId}`,
        postAnswerAlt: null,
        postAnswerSourcePageUrl: null,
        optionExplanations: [],
      },
    }),
  };
}

function cohortTurnResponse(items: ReviewItem[], init?: RequestInit) {
  const request = JSON.parse(String(init?.body)) as { journeyId: string };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      sessionId: request.journeyId,
      mode: 'daily',
      requestedSize: items.length,
      deliveredSize: items.length,
      items: items.map((item) => ({
        deliveryId: item.deliveryId ?? item.id,
        stem: item.stem ?? '',
        options: (item.options ?? []).map(({ label, text }) => ({ label, text })),
        domain: 'usmle/step1/cardiovascular',
        difficulty: item.difficulty ?? 'easy',
        questionType: 'interpretation',
        attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
      })),
    }),
  };
}

describe('UnifiedReview Cohort onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    localStorage.clear();
    setMatchMedia({
      '(pointer: coarse)': false,
      '(prefers-reduced-motion: reduce)': true,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, 'scrollBy', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('persists hook three before experience, retains a failed experience write, then refreshes from the saved choice', async () => {
    let sessionCalls = 0;
    let profilePatchCalls = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, status: 200, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url === '/api/cohort/profile' && init?.method === 'PATCH') {
        profilePatchCalls += 1;
        if (profilePatchCalls === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              profile: {
                hookCompletedAt: '2026-08-13T00:00:00.000Z',
                explicit: {},
              },
              deep: false,
            }),
          };
        }
        if (profilePatchCalls === 2) {
          return { ok: false, status: 503, json: async () => ({ error: 'try again' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              hookCompletedAt: '2026-08-13T00:00:00.000Z',
              explicit: { experience: 'premed' },
            },
            deep: false,
          }),
        };
      }
      if (url === '/api/cohort/profile') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: { hookCompletedAt: null, explicit: {} },
            deep: false,
            demandTopics: [],
          }),
        };
      }
      if (url === '/api/cohort/turn') {
        sessionCalls += 1;
        return cohortTurnResponse(
          sessionCalls === 1
            ? [
                cohortQuestion('hook-1', 'Hook one', true),
                cohortQuestion('hook-2', 'Hook two', true),
                cohortQuestion('hook-3', 'Hook three', true),
              ]
            : [cohortQuestion('adaptive-next', 'Adaptive next')],
          init,
        );
      }
      if (url === '/api/cohort/answer') {
        const body = JSON.parse(String(init?.body)) as {
          deliveryId: string;
          selectedDisplayLabel: string | null;
        };
        return cohortAnswerResponse(body.deliveryId, body.selectedDisplayLabel);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <CohortHostProvider isCohortHost>
        <UnifiedReview rotations={['usmle-step1-open']} cohortSingleTurn />
      </CohortHostProvider>,
    );

    for (const stem of ['Hook one', 'Hook two']) {
      await screen.findByText(stem);
      if (stem === 'Hook two') {
        expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
        fireEvent.keyDown(window, { key: 'z' });
        expect(screen.getByText('Hook two')).toBeInTheDocument();
        expect(screen.queryByText('Hook one')).toBeNull();
      }
      await userEvent.click(screen.getByRole('button', { name: new RegExp(`${stem} option A`) }));
      await userEvent.click(await screen.findByRole('button', { name: /Good \(3\)/i }));
      await screen.findByRole('status', { name: 'Correct' });
      await userEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }

    await screen.findByText('Hook three');
    await userEvent.click(screen.getByRole('button', { name: /Hook three option A/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Good \(3\)/i }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Where are you in your USMLE preparation/i);

    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByText('Hook three')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue/i })).toBeNull();

    const experienceButton = screen.getByRole('button', { name: 'premed' });
    await waitFor(() => expect(experienceButton).toBeEnabled());

    const profilePatches = () => mockFetch.mock.calls.filter(
      ([url, init]) => url === '/api/cohort/profile' && (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(JSON.parse(String((profilePatches()[0]?.[1] as RequestInit).body))).toEqual({
      hookCompleted: true,
    });

    await userEvent.click(experienceButton);
    expect(await screen.findByText(/choice is still pending/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    expect(JSON.parse(String((profilePatches()[1]?.[1] as RequestInit).body))).toEqual({
      experience: 'premed',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(await screen.findByRole('button', { name: /Continue/i }));
    expect(await screen.findByText('Adaptive next')).toBeInTheDocument();
    expect(sessionCalls).toBe(2);
  });

  it('gates the first delivery on the profile read, then commits hook completion before experience', async () => {
    let sessionCalls = 0;
    let hookPatchBody: unknown = null;
    const completedProfile = {
      hookCompletedAt: '2026-08-13T00:00:00.000Z',
      explicit: {},
    };
    type ProfileReadResponse = {
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    };
    let resolveProfileRead!: (response: ProfileReadResponse) => void;
    const profileRead = new Promise<ProfileReadResponse>((resolve) => {
      resolveProfileRead = resolve;
    });

    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, status: 200, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url === '/api/cohort/profile' && init?.method === 'PATCH') {
        hookPatchBody = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: completedProfile, deep: false }),
        };
      }
      if (url === '/api/cohort/profile') return profileRead;
      if (url === '/api/cohort/turn') {
        sessionCalls += 1;
        return cohortTurnResponse([
          cohortQuestion('hook-1', 'Hook one', true),
          cohortQuestion('hook-2', 'Hook two', true),
          cohortQuestion('hook-3', 'Hook three', true),
        ], init);
      }
      if (url === '/api/cohort/answer') {
        const body = JSON.parse(String(init?.body)) as {
          deliveryId: string;
          selectedDisplayLabel: string | null;
        };
        return cohortAnswerResponse(body.deliveryId, body.selectedDisplayLabel);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <CohortHostProvider isCohortHost>
        <UnifiedReview rotations={['usmle-step1-open']} cohortSingleTurn />
      </CohortHostProvider>,
    );

    // Reported 2026-09-15: cohort carried a title, a subtitle and a link above
    // the toolbar, costing ~150px of first screen on the one surface whose whole
    // job is to show a question. The banner is gone; the layout now matches the
    // primary host, which opens straight onto the card behind a 52px toolbar.
    expect(screen.queryByRole('heading', { name: 'USMLE Step 1 practice' })).toBeNull();
    expect(screen.queryByText(/Build your reasoning with practice questions/)).toBeNull();

    await waitFor(() => {
      expect(mockFetch.mock.calls.filter(([url]) => url === '/api/cohort/profile')).toHaveLength(1);
    });
    expect(mockFetch.mock.calls.some(([url]) => (
      url === '/api/cohort/turn'
    ))).toBe(false);
    resolveProfileRead({
      ok: true,
      status: 200,
      json: async () => ({
        profile: { hookCompletedAt: null, explicit: {} },
        deep: false,
        demandTopics: [],
      }),
    });

    expect(screen.queryByRole('link', { name: /Plan a study session/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /How it[’']s built/ })).toBeNull();
    await screen.findByRole('switch', { name: 'Blur images' });
    for (const stem of ['Hook one', 'Hook two']) {
      await screen.findByText(stem);
      await userEvent.click(screen.getByRole('button', { name: new RegExp(`${stem} option A`) }));
      await userEvent.click(await screen.findByRole('button', { name: /Good \(3\)/i }));
      await screen.findByRole('status', { name: 'Correct' });
      await userEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    await screen.findByText('Hook three');
    expect(sessionCalls).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: /Hook three option A/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Good \(3\)/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(hookPatchBody).toEqual({ hookCompleted: true });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'undergrad' })).toBeEnabled();
    });
  });

  it('never creates or adopts a pre-experience delivery for a completed-hook visitor', async () => {
    let sessionCalls = 0;
    let experiencePatchCalls = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, status: 200, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url === '/api/cohort/profile' && init?.method === 'PATCH') {
        experiencePatchCalls += 1;
        if (experiencePatchCalls === 1) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ error: 'experience unavailable' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              hookCompletedAt: '2026-08-12T00:00:00.000Z',
              explicit: { experience: 'undergrad' },
            },
            deep: false,
          }),
        };
      }
      if (url === '/api/cohort/profile') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: { hookCompletedAt: '2026-08-12T00:00:00.000Z', explicit: {} },
            deep: false,
            demandTopics: [],
          }),
        };
      }
      if (url === '/api/cohort/turn') {
        sessionCalls += 1;
        return cohortTurnResponse([cohortQuestion('fresh-turn', 'Fresh turn')], init);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <CohortHostProvider isCohortHost>
        <UnifiedReview
          rotations={['usmle-step1-open']}
          cohortSingleTurn
          initialBatch={{
            ownerKey: 'guest-bootstrap',
            scopeKey: reviewSessionScopeKey({
              rotations: ['usmle-step1-open'],
              feedMode: 'mixed',
              focusRotation: null,
            }),
            items: [cohortQuestion('pre-experience-turn', 'Pre-experience turn')],
            newRemaining: null,
          }}
        />
      </CohortHostProvider>,
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('Pre-experience turn')).toBeNull();
    expect(sessionCalls).toBe(0);
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.queryByRole('button', { name: /Again \(1\)/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'undergrad' }));
    expect(await screen.findByText(/choice is still pending: experience unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(sessionCalls).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    expect(await screen.findByText('Fresh turn')).toBeInTheDocument();
    expect(screen.queryByText('Pre-experience turn')).toBeNull();
    expect(sessionCalls).toBe(1);
    expect(experiencePatchCalls).toBe(2);
  });

  it('fails closed when a returning visitor profile cannot be loaded', async () => {
    let sessionCalls = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, status: 200, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url === '/api/cohort/profile') {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'profile unavailable' }),
        };
      }
      if (url === '/api/cohort/turn') {
        sessionCalls += 1;
        return cohortTurnResponse([cohortQuestion('returning-turn', 'Returning turn')]);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <CohortHostProvider isCohortHost>
        <UnifiedReview rotations={['usmle-step1-open']} cohortSingleTurn />
      </CohortHostProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/profile unavailable/i);
    expect(screen.queryByText('Returning turn')).toBeNull();
    expect(sessionCalls).toBe(0);
    expect(screen.queryByRole('button', { name: /Again \(1\)/i })).toBeNull();
    expect(mockFetch.mock.calls.some(([url]) => url === '/api/cohort/answer')).toBe(false);
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.queryByText('Returning turn')).toBeNull();
    expect(sessionCalls).toBe(0);
  });

  it('opens demand in-page after the eighth durable answer without another profile round trip', async () => {
    let profileReads = 0;
    let sessionCalls = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, status: 200, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url === '/api/cohort/profile' && !init?.method) {
        profileReads += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              hookCompletedAt: '2026-08-12T00:00:00.000Z',
              explicit: { experience: 'undergrad' },
            },
            deep: false,
            // Seven historical public answers; the acknowledged answer below
            // is the durable eighth one.
            publicGradedCount: 7,
            demandTopics: [{ id: 'diabetes', label: 'diabetes' }],
          }),
        };
      }
      if (url === '/api/cohort/turn') {
        sessionCalls += 1;
        return cohortTurnResponse([cohortQuestion('eighth-turn', 'Eighth turn')], init);
      }
      if (url === '/api/cohort/answer') {
        const body = JSON.parse(String(init?.body)) as {
          deliveryId: string;
          selectedDisplayLabel: string | null;
        };
        return cohortAnswerResponse(body.deliveryId, body.selectedDisplayLabel);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <CohortHostProvider isCohortHost>
        <UnifiedReview rotations={['usmle-step1-open']} cohortSingleTurn />
      </CohortHostProvider>,
    );

    await screen.findByText('Eighth turn');
    expect(profileReads).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: /Eighth turn option A/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Good \(3\)/i }));

    expect(await screen.findByRole('dialog')).toHaveTextContent(
      /Which Step 1 topics would you like to practise/i,
    );
    expect(screen.getByRole('button', { name: 'diabetes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue/i })).toBeNull();
    expect(profileReads).toBe(1);
    expect(sessionCalls).toBe(1);

    const profileReadCalls = mockFetch.mock.calls.filter(([url, requestInit]) => (
      url === '/api/cohort/profile' && !(requestInit as RequestInit | undefined)?.method
    ));
    expect(profileReadCalls).toHaveLength(1);
    for (const [, requestInit] of profileReadCalls) {
      expect((requestInit as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('keeps a failed hook-completion write blocking and retryable', async () => {
    let sessionCalls = 0;
    let hookPatchCalls = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, status: 200, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url === '/api/cohort/profile' && init?.method === 'PATCH') {
        hookPatchCalls += 1;
        if (hookPatchCalls === 1) {
          return { ok: false, status: 503, json: async () => ({ error: 'hook failed' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              hookCompletedAt: '2026-08-13T00:00:00.000Z',
              explicit: { experience: 'medical-student' },
            },
            deep: false,
          }),
        };
      }
      if (url === '/api/cohort/profile') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: { hookCompletedAt: null, explicit: { experience: 'medical-student' } },
            deep: false,
            demandTopics: [],
          }),
        };
      }
      if (url === '/api/cohort/turn') {
        sessionCalls += 1;
        return cohortTurnResponse(
          sessionCalls === 1
            ? [
                cohortQuestion('hook-1', 'Hook one', true),
                cohortQuestion('hook-2', 'Hook two', true),
                cohortQuestion('final-hook', 'Final hook', true),
              ]
            : [cohortQuestion('post-hook', 'Post-hook turn')],
          init,
        );
      }
      if (url === '/api/cohort/answer') {
        const body = JSON.parse(String(init?.body)) as {
          deliveryId: string;
          selectedDisplayLabel: string | null;
        };
        return cohortAnswerResponse(body.deliveryId, body.selectedDisplayLabel);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <CohortHostProvider isCohortHost>
        <UnifiedReview rotations={['usmle-step1-open']} cohortSingleTurn />
      </CohortHostProvider>,
    );

    for (const stem of ['Hook one', 'Hook two']) {
      await screen.findByText(stem);
      await userEvent.click(screen.getByRole('button', { name: new RegExp(`${stem} option A`) }));
      await userEvent.click(await screen.findByRole('button', { name: /Good \(3\)/i }));
      await screen.findByRole('status', { name: 'Correct' });
      await userEvent.click(screen.getByRole('button', { name: /Continue/i }));
    }
    await screen.findByText('Final hook');
    await userEvent.click(screen.getByRole('button', { name: /Final hook option A/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Good \(3\)/i }));
    expect(await screen.findByText(/choice is still pending: hook failed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue/i })).toBeNull();

    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByText('Final hook')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await userEvent.click(await screen.findByRole('button', { name: /Continue/i }));
    expect(await screen.findByText('Post-hook turn')).toBeInTheDocument();
    expect(hookPatchCalls).toBe(2);
  });

  it('keeps a failed deep-demand write modal, enum-only, and retryable without advancing', async () => {
    let sessionCalls = 0;
    let demandPatchCalls = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, status: 200, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url === '/api/cohort/profile' && init?.method === 'PATCH') {
        demandPatchCalls += 1;
        if (demandPatchCalls === 1) {
          return { ok: false, status: 503, json: async () => ({ error: 'demand failed' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              hookCompletedAt: '2026-08-12T00:00:00.000Z',
              explicit: {
                experience: 'undergrad',
                demand: {
                  topics: ['diabetes'],
                  askedAt: '2026-08-13T00:00:00.000Z',
                },
              },
            },
            deep: true,
          }),
        };
      }
      if (url === '/api/cohort/profile') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              hookCompletedAt: '2026-08-12T00:00:00.000Z',
              explicit: { experience: 'undergrad' },
            },
            deep: true,
            demandTopics: [{ id: 'diabetes', label: 'diabetes' }],
          }),
        };
      }
      if (url === '/api/cohort/turn') {
        sessionCalls += 1;
        return cohortTurnResponse([cohortQuestion(
          sessionCalls === 1 ? 'deep-turn' : 'post-demand-turn',
          sessionCalls === 1 ? 'Deep turn' : 'Post-demand turn',
        )], init);
      }
      if (url === '/api/cohort/answer') {
        const body = JSON.parse(String(init?.body)) as {
          deliveryId: string;
          selectedDisplayLabel: string | null;
        };
        return cohortAnswerResponse(body.deliveryId, body.selectedDisplayLabel);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <CohortHostProvider isCohortHost>
        <UnifiedReview rotations={['usmle-step1-open']} cohortSingleTurn />
      </CohortHostProvider>,
    );

    await screen.findByText('Deep turn');
    await userEvent.click(screen.getByRole('button', { name: /Deep turn option A/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Good \(3\)/i }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Which Step 1 topics would you like to practise/i);
    expect(screen.queryByRole('button', { name: /Continue/i })).toBeNull();

    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByText('Deep turn')).toBeInTheDocument();

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'diabetes' }));
    await userEvent.click(saveButton);
    expect(await screen.findByText(/choice is still pending: demand failed/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const demandPatches = mockFetch.mock.calls.filter(
      ([url, init]) => url === '/api/cohort/profile' && (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(JSON.parse(String((demandPatches[0]?.[1] as RequestInit).body))).toEqual({
      demand: { topics: ['diabetes'] },
    });

    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByText('Deep turn')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(await screen.findByRole('button', { name: /Continue/i }));
    expect(await screen.findByText('Post-demand turn')).toBeInTheDocument();
    expect(sessionCalls).toBe(2);
  });

  it('keeps typed search local and sends only the selected topic id on the next turn', async () => {
    let sessionCalls = 0;
    const turnBodies: Array<Record<string, unknown>> = [];
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, status: 200, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url === '/api/cohort/profile') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              hookCompletedAt: '2026-08-12T00:00:00.000Z',
              explicit: { experience: 'medical-student' },
            },
            deep: false,
            publicGradedCount: 0,
            demandTopics: [],
            searchTopics: [{
              id: 'ecg-basics',
              label: 'ECG basics',
              aliases: ['EKG', 'electrocardiogram'],
              searchIntents: ['how to read an ECG'],
              learningOutcomes: ['Recognise waves and common rhythm patterns.'],
              modalities: ['text', 'ecg'],
              eligibleItemCount: 6,
              eligibleAssetCount: 5,
            }],
          }),
        };
      }
      if (url === '/api/cohort/turn') {
        sessionCalls += 1;
        turnBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return cohortTurnResponse([
          cohortQuestion(
            sessionCalls === 1 ? 'discovery-turn' : 'ecg-turn',
            sessionCalls === 1 ? 'Discovery turn' : 'ECG turn',
          ),
        ], init);
      }
      if (url === '/api/cohort/answer') {
        const body = JSON.parse(String(init?.body)) as {
          deliveryId: string;
          selectedDisplayLabel: string | null;
        };
        return cohortAnswerResponse(body.deliveryId, body.selectedDisplayLabel);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <CohortHostProvider isCohortHost>
        <UnifiedReview rotations={['usmle-step1-open']} cohortSingleTurn />
      </CohortHostProvider>,
    );

    await screen.findByText('Discovery turn');
    await userEvent.click(screen.getByRole('button', { name: /search the deck/i }));
    await userEvent.type(screen.getByRole('searchbox'), 'electrocardiogram');
    await userEvent.click(screen.getByRole('button', { name: /learn ecg basics/i }));
    expect(screen.getByText('Learning: ECG basics')).toBeInTheDocument();
    expect(window.location.search).toBe('?topic=ecg-basics');

    await userEvent.click(screen.getByRole('button', { name: /Discovery turn option A/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Good \(3\)/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Continue/i }));
    expect(await screen.findByText('ECG turn')).toBeInTheDocument();

    expect(turnBodies[0]).not.toHaveProperty('searchTopicId');
    expect(turnBodies[1]).toMatchObject({ searchTopicId: 'ecg-basics' });
    expect(turnBodies[1].journeyId).toBe(turnBodies[0].journeyId);
    expect(JSON.stringify(mockFetch.mock.calls)).not.toContain('electrocardiogram');
  });
});

describe('daily-progress pill follows the current objective', () => {
  /** Every daily-target URL the component asked for. */
  function dailyTargetUrls(): string[] {
    return mockFetch.mock.calls
      .map(([input]) => (typeof input === 'string' ? input : String(input)))
      .filter((url) => url.includes('/api/study/daily-target'));
  }

  it('asks only for the objective and a distinct focused deck', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, json: async () => DAILY_TARGET_RESPONSE };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    });

    render(
      <UnifiedReview
        rotations={['nsx']}
        studyableRotations={['anatomy', 'surgical-sciences', 'cah']}
        examRotation="cah"
        focusRotation="nsx"
      />,
    );

    await waitFor(() => expect(dailyTargetUrls().length).toBeGreaterThan(0));
    const asked = dailyTargetUrls().join(' ');
    expect(asked).toContain('cah');
    expect(asked).toContain('nsx');
    expect(asked).not.toContain('anatomy');
    expect(asked).not.toContain('surgical-sciences');
  });

  it('falls back to the session rotations when nothing is studyable', async () => {
    // Guests and Cohort hosts pass an empty studyable set; they must keep the
    // behaviour they had rather than losing the pill's denominator entirely.
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, json: async () => DAILY_TARGET_RESPONSE };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    });

    render(<UnifiedReview rotations={['critical-care']} studyableRotations={[]} />);

    await waitFor(() => expect(dailyTargetUrls().length).toBeGreaterThan(0));
    expect(dailyTargetUrls().join(' ')).toContain('critical-care');
  });
});

describe('UnifiedReview Cohort module cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    localStorage.clear();
    setMatchMedia({ '(pointer: coarse)': false, '(prefers-reduced-motion: reduce)': true });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    Object.defineProperty(window, 'scrollBy', { configurable: true, writable: true, value: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('grades a card against its delivery and asks for the next turn only once the grade has landed', async () => {
    const turnBodies: Array<Record<string, unknown>> = [];
    let releaseGrade!: () => void;
    const gradeGate = new Promise<void>((resolve) => { releaseGrade = resolve; });
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) return { ok: true, status: 200, json: async () => DAILY_TARGET_RESPONSE };
      if (url === '/api/cohort/profile') {
        return {
          ok: true, status: 200,
          json: async () => ({ profile: { hookCompletedAt: '2026-08-12T00:00:00.000Z', explicit: { experience: 'undergrad' } }, deep: false, demandTopics: [] }),
        };
      }
      if (url === '/api/cohort/turn') {
        turnBodies.push(JSON.parse(String(init?.body)));
        if (turnBodies.length === 1) {
          return {
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({
              sessionId: turnBodies[0].journeyId, mode: 'daily', requestedSize: 1, deliveredSize: 1,
              items: [{
                deliveryId: 'card-delivery-0001', kind: 'card', front: 'The first-line treatment for croup is oral [___].',
                back: 'dexamethasone', context: 'A single dose reduces return visits.', domain: 'Paediatrics',
                attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
              }],
            }),
          };
        }
        return cohortTurnResponse([cohortQuestion('next-question', 'Next module question')], init);
      }
      if (url === '/api/cohort/card-grade') {
        await gradeGate;
        return { ok: true, status: 200, json: async () => ({ ok: true, deduped: false }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <CohortHostProvider isCohortHost>
        <UnifiedReview rotations={['usmle-step1-open']} cohortSingleTurn />
      </CohortHostProvider>,
    );

    expect(await screen.findByText(/first-line treatment for croup/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Show answer/ }));
    expect(await screen.findByText('dexamethasone')).toBeInTheDocument();
    // md3's card affordances are keyed to an md3 card id and md3-only routes:
    // a Cohort card offers none of them.
    expect(screen.queryByRole('link', { name: /Details/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /like|hide|suppress/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Good \(3\)/ }));

    const gradeCall = mockFetch.mock.calls.find(([url]) => url === '/api/cohort/card-grade');
    expect(JSON.parse(String(gradeCall![1]!.body))).toMatchObject({ deliveryId: 'card-delivery-0001', confidence: 3 });
    // Not before the grade lands: the server would refuse an ungraded predecessor.
    expect(turnBodies).toHaveLength(1);
    // md3's own record route (quarantined on Cohort) never receives the grade.
    expect(mockFetch.mock.calls.some(([url, init]) => url === '/api/study/record'
      && String(init?.body ?? '').includes('quality'))).toBe(false);

    await act(async () => { releaseGrade(); });
    expect(await screen.findByText('Next module question')).toBeInTheDocument();
    expect(turnBodies[1]).toMatchObject({ nextDrawOrdinal: 1, previousDeliveryId: 'card-delivery-0001' });
  });
});
