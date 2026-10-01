/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import USMLEPage from './page';

describe('USMLEPage', () => {
  it('presents a quiet study entry with an unmistakable GitHub fork path', () => {
    render(<USMLEPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'cohort.md' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not a score or pass prediction/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start Step 1 study/i })).toHaveAttribute(
      'href',
      '/usmle/step1',
    );
    expect(screen.getByRole('link', { name: /Fork on GitHub/i })).toHaveAttribute(
      'href',
      'https://github.com/todd866/cohort',
    );
    expect(screen.queryByText(/Coming Soon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Step 2/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/flashcard/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/administrator-only/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/First Aid/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Steal this bank/i)).not.toBeInTheDocument();
  });
});
