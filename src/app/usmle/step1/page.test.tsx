/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import USMLEStep1Page from './page';

const progress = {
  corpus: { eligible: 25 },
  baseline: {
    total: 25,
    attempted: 4,
    correct: 3,
    remaining: 21,
    complete: false,
  },
  coverage: { attempted: 4, unseen: 21 },
  activity: {
    totalAttempts: 5,
    correctAttempts: 3,
    todayAttempts: 2,
    recent7dAttempts: 5,
  },
  domains: [
    { domain: 'usmle/step1/endocrine', eligible: 7, attempted: 2, correct: 1, unseen: 5 },
    { domain: 'usmle/step1/microbiology', eligible: 8, attempted: 2, correct: 2, unseen: 6 },
  ],
  dailyTarget: 10,
  nextAction: 'baseline',
  limitations: [
    'Descriptive coverage only; not an exam score or pass prediction.',
  ],
};

describe('USMLEStep1Page', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => progress,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders an honest baseline and daily-study home', async () => {
    render(<USMLEStep1Page />);

    expect(await screen.findByText('25 open questions')).toBeInTheDocument();
    expect(screen.getByText('4 of 25 attempted')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /continue baseline/i })).toHaveAttribute(
      'href',
      '/usmle/step1/study?mode=baseline',
    );
    expect(screen.getByRole('link', { name: /start daily session/i })).toHaveAttribute(
      'href',
      '/usmle/step1/study?mode=daily',
    );
    expect(screen.getByText(/not a score or pass prediction/i)).toBeInTheDocument();
    expect(screen.getByText(/cited MCQs/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/auth/signin',
    );
    expect(screen.queryByText(/flashcard/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/first aid/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/predicted score/i)).not.toBeInTheDocument();
  });

  it('shows a bounded retry state when progress cannot load', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Unavailable' }),
    } as Response);

    render(<USMLEStep1Page />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i);
    expect(screen.getByRole('button', { name: /retry progress/i })).toBeInTheDocument();
  });
});
