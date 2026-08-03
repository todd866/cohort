/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import USMLEPage from './page';

describe('USMLEPage', () => {
  it('presents one Step 1 MCQ CTA without Coming Soon noise', () => {
    render(<USMLEPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: /cited Step 1 MCQs/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/25 original, redistributable MCQs/i)).toBeInTheDocument();
    expect(screen.getByText(/does not estimate a score/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start Step 1 study/i })).toHaveAttribute(
      'href',
      '/usmle/step1',
    );
    expect(screen.queryByText(/Coming Soon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Step 2/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/flashcard/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/administrator-only/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/First Aid/i)).not.toBeInTheDocument();
  });
});
