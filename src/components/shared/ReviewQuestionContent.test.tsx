/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReviewQuestionContent, ReviewQuestionOptions, ReviewQuestionResultBody } from './ReviewQuestionContent';

describe('ReviewQuestionContent', () => {
  it('composes stem, options, result and media through the prompt layout', () => {
    render(<ReviewQuestionContent layout="prompt" stem={<p>stem</p>} options={<button>Option A</button>} result={<p>result</p>} media={<img alt="figure" />} tail={<p>next</p>} />);
    expect(screen.getByText('stem')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Option A' })).toBeInTheDocument();
    expect(screen.getByText('result')).toBeInTheDocument();
    expect(screen.getByAltText('figure')).toBeInTheDocument();
    expect(screen.getByText('next')).toBeInTheDocument();
  });

  it('renders ordinary options and keeps reveal enabled while a prompt image is blocked', () => {
    const onSelect = vi.fn();
    const onReveal = vi.fn();
    render(<ReviewQuestionOptions options={[{ label: 'A', text: 'First finding' }]} selectedOption={null} disabled onSelect={onSelect} onReveal={onReveal} revealDisabled={false} revealLabel="Show answer" />);
    expect(screen.getByRole('button', { name: /First finding/ })).toBeDisabled();
    const reveal = screen.getByRole('button', { name: 'Show answer' });
    expect(reveal).toBeEnabled();
    fireEvent.click(reveal);
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it('exposes the current answer selection before grading and updates it when changed', () => {
    const options = [{ label: 'A', text: 'First finding' }, { label: 'B', text: 'Second finding' }];
    const onSelect = vi.fn();
    const { rerender } = render(<ReviewQuestionOptions options={options} selectedOption="A" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: 'A. First finding' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'B. Second finding' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'B. Second finding' }));
    expect(onSelect).toHaveBeenCalledWith('B');
    rerender(<ReviewQuestionOptions options={options} selectedOption="B" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: 'A. First finding' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'B. Second finding' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders correctness and shared explanation markup from plain result data', () => {
    render(<ReviewQuestionResultBody result={{ isCorrect: false, correctOption: 'B' }} explanation="Because this is the key distinction." />);
    expect(screen.getByRole('status', { name: 'Incorrect' })).toBeInTheDocument();
    expect(screen.getByText('Because this is the key distinction.')).toBeInTheDocument();
  });
});
