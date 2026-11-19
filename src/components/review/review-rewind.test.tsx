/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UnifiedReview } from './UnifiedReview';
import { clearAnsweredSlots } from '@/lib/review/answered-slots';
import { OUTBOX_STORAGE_KEY } from '@/lib/outbox';

vi.mock('next-auth/react', async () => ({
  useSession: vi.fn(() => ({ data: null, status: 'unauthenticated' })),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  SessionContext: (await import('react')).createContext(undefined),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const DAILY_TARGET_RESPONSE = {
  dailyTarget: 20,
  coverage: { seen: 5, total: 100, percent: 5, seenCards: 3, totalCards: 60, seenQuestions: 2, totalQuestions: 40 },
  daysToExam: 10,
  examDate: '2026-03-06',
  todayReviewed: 5,
};

function card(index: number) {
  return {
    type: 'card' as const,
    id: `card-${index}`,
    rotation: 'critical-care',
    front: `Rewind card ${index} names [___].`,
    back: `rewind-answer-${index}`,
    serveDecisionId: `decision-${index}`,
    sessionId: 'session-live',
    batchId: 'batch-live',
    decisionContext: { servedBy: 'manifold-walk' },
  };
}

function recordBodies(): Array<Record<string, unknown>> {
  return mockFetch.mock.calls
    .filter(([url, init]) => String(url).includes('/api/study/record') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
    .filter(body => body.type !== 'warmup');
}

function uniqueRecords(): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const body of recordBodies()) byId.set(String(body.clientRequestId), body);
  return [...byId.values()];
}

describe('in-place rewind on the review surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    localStorage.clear();
    clearAnsweredSlots();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('grades a rewound card as a new event, records nothing when stepping past, and restores the live card', async () => {
    const user = userEvent.setup();
    let sessionGets = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/study/daily-target')) {
        return { ok: true, json: async () => DAILY_TARGET_RESPONSE };
      }
      if (url.includes('/api/study/unified-session') && !init?.method) {
        sessionGets += 1;
        return { ok: true, json: async () => ({ items: [0, 1, 2, 3, 4, 5, 6, 7].map(card) }) };
      }
      if (url.includes('/api/study/record') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { metadata?: { servedBy?: string } };
        if (body.metadata?.servedBy === 'session-rewind') {
          return { ok: false, status: 503, json: async () => ({ error: 'offline' }) };
        }
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<UnifiedReview rotations={['critical-care']} />);

    for (let index = 0; index < 3; index++) {
      expect(await screen.findByText(`Rewind card ${index} names`)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Show answer/ }));
      expect(await screen.findByText(`rewind-answer-${index}`)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Good (3)' }));
    }

    expect(await screen.findByText('Rewind card 3 names')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show answer/ }));
    expect(await screen.findByText('rewind-answer-3')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Today 8 of 20/ })).toBeInTheDocument();
    const beforeRewind = uniqueRecords();
    expect(beforeRewind).toHaveLength(3);
    expect(beforeRewind.map(body => body.id)).toEqual(['card-0', 'card-1', 'card-2']);
    expect(beforeRewind.every(body => body.serveDecisionId && body.sessionId === 'session-live' && body.batchId === 'batch-live')).toBe(true);
    const earlier = structuredClone(beforeRewind);
    const sessionGetsBefore = sessionGets;

    fireEvent.keyDown(window, { key: 'z' });
    expect(await screen.findByText('1 back')).toBeInTheDocument();
    expect(screen.getByText('Rewind card 2 names')).toBeInTheDocument();
    expect(screen.queryByText('rewind-answer-2')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Z', shiftKey: true });
    expect(await screen.findByText('rewind-answer-3')).toBeInTheDocument();
    expect(screen.queryByText('1 back')).not.toBeInTheDocument();
    expect(uniqueRecords()).toEqual(earlier);

    fireEvent.keyDown(window, { key: 'z' });
    fireEvent.keyDown(window, { key: 'z' });
    expect(await screen.findByText('2 back')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous item' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next item' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Review history' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Previous questions/ })).not.toBeInTheDocument();
    expect(screen.getByText('Rewind card 1 names')).toBeInTheDocument();
    expect(screen.queryByText('rewind-answer-1')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Show answer/ }));
    await user.click(screen.getByRole('button', { name: 'Good (3)' }));

    expect(await screen.findByText('Rewind card 2 names')).toBeInTheDocument();
    expect(screen.queryByText('rewind-answer-2')).not.toBeInTheDocument();
    expect(await screen.findByText('1 back')).toBeInTheDocument();
    const afterGrade = uniqueRecords();
    expect(afterGrade).toHaveLength(4);
    expect(afterGrade.slice(0, 3)).toEqual(earlier);
    const rewindGrade = afterGrade[3]!;
    expect(rewindGrade.id).toBe('card-1');
    expect(rewindGrade.type).toBe('card');
    expect(rewindGrade.clientRequestId).toEqual(expect.any(String));
    expect(earlier.map(body => body.clientRequestId)).not.toContain(rewindGrade.clientRequestId);
    expect(rewindGrade).not.toHaveProperty('serveDecisionId');
    expect(rewindGrade).not.toHaveProperty('sessionId');
    expect(rewindGrade).not.toHaveProperty('batchId');
    expect(rewindGrade.metadata).toMatchObject({ servedBy: 'session-rewind' });
    expect(await screen.findByRole('button', { name: /Today 9 of 20/ })).toBeInTheDocument();

    await waitFor(() => {
      const queued = JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) || '[]') as Array<{ body?: Record<string, unknown> }>;
      const rewind = queued.filter(entry => (entry.body?.metadata as { servedBy?: string } | undefined)?.servedBy === 'session-rewind');
      expect(rewind).toHaveLength(1);
      expect(rewind[0]?.body?.clientRequestId).toBe(rewindGrade.clientRequestId);
      expect(queued.some(entry => entry.body?.clientRequestId === earlier[0]?.clientRequestId)).toBe(false);
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await screen.findByText('Rewind card 3 names')).toBeInTheDocument();
    expect(screen.getByText('rewind-answer-3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next item' })).not.toBeInTheDocument();
    expect(uniqueRecords()).toHaveLength(4);
    expect(sessionGets).toBe(sessionGetsBefore);
  });
});
