/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CardFeedback } from './CardFeedback';

/**
 * The like/hide buttons are icon-only. They previously conveyed their purpose
 * only via title=, which is not a reliable accessible name. A screen reader
 * announced them as bare "button". Guard that each carries an explicit
 * aria-label and that the decorative SVGs are hidden from the a11y tree.
 */
describe('CardFeedback accessibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  it('gives the like and hide buttons explicit aria-labels', () => {
    render(<CardFeedback cardId="c1" sourceComponent="test" />);
    const [like, hide] = screen.getAllByRole('button');
    expect(like).toHaveAttribute('aria-label', 'Show me more cards like this');
    expect(hide).toHaveAttribute('aria-label', 'Hide this card');
  });

  it('reflects the liked state in the like button aria-label', () => {
    render(<CardFeedback cardId="c1" sourceComponent="test" liked />);
    const [like] = screen.getAllByRole('button');
    expect(like).toHaveAttribute('aria-label', 'Remove upvote');
  });

  it('marks the decorative icons aria-hidden', () => {
    const { container } = render(<CardFeedback cardId="c1" sourceComponent="test" />);
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);
    svgs.forEach((svg) => expect(svg).toHaveAttribute('aria-hidden', 'true'));
  });

  it('adds delivery-scoped good and bad controls when a ServeDecision is available', () => {
    render(
      <CardFeedback
        cardId="c1"
        serveDecisionId="decision-1"
        sourceComponent="test"
      />,
    );

    expect(screen.getByRole('button', { name: 'Mark as a good card (g)' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Mark as a bad card (b)' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows only content-rating controls for questions', () => {
    render(
      <CardFeedback
        cardId="q1"
        itemType="question"
        serveDecisionId="decision-1"
        sourceComponent="MCQ"
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Mark as a good question (g)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as a bad question (b)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more cards/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hide/i })).not.toBeInTheDocument();
  });

  it('does not offer untrusted question feedback without a ServeDecision', () => {
    const { container } = render(
      <CardFeedback cardId="q1" itemType="question" sourceComponent="MCQ" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('posts a good rating and toggles the same control to clear', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    render(
      <CardFeedback
        cardId="q1"
        itemType="question"
        serveDecisionId="decision-1"
        sourceComponent="MCQ"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mark as a good question (g)' }));

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/study/content-rating', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemType: 'question',
        itemId: 'q1',
        serveDecisionId: 'decision-1',
        rating: 'good',
        sourceComponent: 'MCQ',
      }),
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByRole('button', { name: 'Clear good question rating (g)' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Clear good question rating (g)' }));

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/study/content-rating', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemType: 'question',
        itemId: 'q1',
        serveDecisionId: 'decision-1',
        rating: 'clear',
        sourceComponent: 'MCQ',
      }),
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByRole('button', { name: 'Mark as a good question (g)' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('rolls back an optimistic rating when the endpoint rejects it', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    render(
      <CardFeedback
        cardId="c1"
        serveDecisionId="decision-1"
        sourceComponent="KeyPoint"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mark as a bad card (b)' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mark as a bad card (b)' })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('shows only thumbs for a public delivery and posts to Cohort feedback', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    render(<CardFeedback cardId="canonical-id" publicDeliveryId="delivery-1" sourceComponent="KeyPoint" />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /more cards/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark as a good card (g)' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/cohort/feedback', expect.objectContaining({
      body: expect.stringContaining('"deliveryId":"delivery-1"'),
    }));
    expect(fetchMock.mock.calls[0][1]?.body).toEqual(expect.stringContaining('"kind":"rating"'));
  });

  it('ignores a late rating completion after the delivery changes', async () => {
    const user = userEvent.setup();
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    const { rerender } = render(<CardFeedback cardId="canonical-id" publicDeliveryId="delivery-1" sourceComponent="KeyPoint" />);
    await user.click(screen.getByRole('button', { name: 'Mark as a good card (g)' }));
    rerender(<CardFeedback cardId="canonical-id" publicDeliveryId="delivery-2" sourceComponent="KeyPoint" />);
    resolve({ ok: true } as Response);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark as a good card (g)' })).toHaveAttribute('aria-pressed', 'false'));
  });
});
