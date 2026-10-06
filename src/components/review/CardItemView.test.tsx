/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import type { ReviewItem } from './hooks/types';

vi.mock('@/components/shared/AnatomyReviewFigure', () => ({
  AnatomyReviewFigure: ({ alt, revealed }: { alt: string; revealed: boolean }) => (
    <div data-testid="anatomy-figure" data-alt={alt} data-revealed={String(revealed)} />
  ),
}));

import { CardItemView, imageIsPrompt, numberedAnatomyPresentation } from './CardItemView';

const anatomyMedia = {
  figureId: 'abducens-local' as const,
  target: 'lateral-rectus' as const,
  role: 'prompt' as const,
  preAnswerAlt: 'Target marker on the anatomy figure',
  postAnswerAlt: 'Labelled anatomy figure',
  attribution: { text: 'Open source anatomy figure', licence: 'CC BY' },
};

function card(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    type: 'card', id: 'delivery-1', rotation: 'anatomy', week: null,
    front: 'Which structure is marked? [___]', back: 'lateral rectus',
    ...overrides,
  };
}

const viewProps = {
  revealedBlanks: 0,
  blankCount: 1,
  cardAnswerRef: createRef<HTMLDivElement>(),
  handleReveal: vi.fn(),
  onSuppress: vi.fn(),
};

describe('CardItemView public anatomy media', () => {
  it('shows the target prompt before reveal and answer label after reveal', () => {
    const { rerender } = render(
      <CardItemViewTest item={card({ publicAnatomyMedia: anatomyMedia })} cardFullyRevealed={false} />,
    );
    expect(screen.getByTestId('anatomy-figure')).toHaveAttribute('data-alt', anatomyMedia.preAnswerAlt);
    expect(screen.getByTestId('anatomy-figure')).toHaveAttribute('data-revealed', 'false');
    expect(screen.getByLabelText('blank')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    rerender(<CardItemViewTest item={card({ publicAnatomyMedia: anatomyMedia })} cardFullyRevealed />);
    expect(screen.getByTestId('anatomy-figure')).toHaveAttribute('data-alt', anatomyMedia.postAnswerAlt);
    expect(screen.getByTestId('anatomy-figure')).toHaveAttribute('data-revealed', 'true');
    expect(screen.getByText('lateral rectus')).toBeInTheDocument();
  });

  it('keeps supplementary public anatomy hidden until reveal', () => {
    const supplementary = { ...anatomyMedia, role: 'supplementary' as const };
    const { rerender } = render(
      <CardItemViewTest item={card({ publicAnatomyMedia: supplementary })} cardFullyRevealed={false} />,
    );
    expect(screen.queryByTestId('anatomy-figure')).not.toBeInTheDocument();
    rerender(<CardItemViewTest item={card({ publicAnatomyMedia: supplementary })} cardFullyRevealed />);
    expect(screen.getByTestId('anatomy-figure')).toHaveAttribute('data-alt', supplementary.postAnswerAlt);
    expect(screen.getByTestId('anatomy-figure')).toHaveAttribute('data-revealed', 'true');
  });

  it('allows public feedback after reveal without exposing private card routes', () => {
    render(
      <CardItemViewTest
        item={card({ publicAnatomyMedia: anatomyMedia, crosslinks: { primary: '/private-crosslink' } })}
        cardFullyRevealed
        publicFeedback={<button type="button">Report issue</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Report issue' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('Details ↗')).not.toBeInTheDocument();
    expect(screen.getByText('Source').closest('details')).toHaveTextContent('Open source anatomy figure');
  });
});

// Keep the production prop surface in one place while allowing the focused
// tests above to stay readable.
function CardItemViewTest(props: { item: ReviewItem; cardFullyRevealed: boolean; publicFeedback?: ReactNode }) {
  return <CardItemView {...viewProps} {...props} publicSurface publicFeedback={props.publicFeedback} />;
}

/**
 * Locks the image-as-prompt render contract (S1): a card image is shown ABOVE
 * the cloze (visible pre-reveal, as the question) iff its sidecar is
 * `class: 'diagnostic'` and not `showWhen: 'after-reveal'`. Image-as-prompt
 * cards depend on this — if it regresses, the clinical image stops being the
 * prompt and silently drops to a post-reveal decoration. No render change was
 * needed for S1; this guards the contract it relies on.
 */
describe('imageIsPrompt (image-as-prompt render contract)', () => {
  it('diagnostic + showWhen omitted (defaults to always) → prompt', () => {
    expect(imageIsPrompt({ class: 'diagnostic' })).toBe(true);
  });
  it("diagnostic + showWhen 'always' → prompt", () => {
    expect(imageIsPrompt({ class: 'diagnostic', showWhen: 'always' })).toBe(true);
  });
  it("diagnostic + showWhen 'after-reveal' → NOT prompt (confirms the answer)", () => {
    expect(imageIsPrompt({ class: 'diagnostic', showWhen: 'after-reveal' })).toBe(false);
  });
  it('non-diagnostic (diagram/decorative/lake-reference) → NOT prompt', () => {
    expect(imageIsPrompt({ class: 'diagram', showWhen: 'always' })).toBe(false);
    expect(imageIsPrompt({ class: 'decorative' })).toBe(false);
    expect(imageIsPrompt({ class: 'lake-reference', showWhen: 'always' })).toBe(false);
  });
  it('no meta → NOT prompt', () => {
    expect(imageIsPrompt(undefined)).toBe(false);
    expect(imageIsPrompt(null)).toBe(false);
  });
  it('explicit source role → prompt even when metadata is missing or stale', () => {
    expect(imageIsPrompt(undefined, 'prompt')).toBe(true);
    expect(imageIsPrompt({ class: 'diagram', showWhen: 'after-reveal' }, 'prompt')).toBe(true);
  });
});

/**
 * Autoscroll is MCQ-only (long option lists). Cards never post-reveal-scroll:
 * cloze answers fill in place, and yanking to context would hide them.
 * imageIsPrompt remains the render contract for where the figure sits.
 */
describe('image-as-prompt (no card autoscroll)', () => {
  it('prompt figures sit above the cloze; cards do not autoscroll past them', () => {
    expect(imageIsPrompt({ class: 'diagnostic', showWhen: 'always' })).toBe(true);
    expect(imageIsPrompt({ class: 'diagnostic', showWhen: 'after-reveal' })).toBe(false);
  });
});

describe('numbered atlas presentation', () => {
  const context = 'Rohen, Yokochi & Lutjen-Drecoll, Anatomy: A Photographic Atlas. The numbers are printed on the photograph; name the structure the leader line points to.';
  const title = 'Brain and Cranial Nerves: Nerves II, III, IV, V1, and VI';
  const front = `${title} — name structure **7** in the photograph. [___]`;
  it('keeps the target and answer blank while removing repeated titles and instructions', () => {
    expect(numberedAnatomyPresentation(front, context, title)).toMatchObject({
      front: 'Identify structure **7**. [___]', context: '', caption: null,
      source: 'Rohen, Yokochi & Lutjen-Drecoll, Anatomy: A Photographic Atlas.',
    });
  });
  it('preserves function and clinical teaching, and meaningful figure captions', () => {
    const teaching = 'Supplies lateral rectus.\\n\\nInjury impairs eye abduction.';
    expect(numberedAnatomyPresentation(front, `${teaching}\\n\\n${context}`, 'Superior view')).toMatchObject({
      context: teaching, caption: 'Superior view',
    });
  });
  it('does not change other clinical prompts or discard their explanations', () => {
    const other = 'Which cranial nerve is affected? [___]';
    expect(numberedAnatomyPresentation(other, context, title)).toEqual({ front: other, context, caption: title, source: null });
  });
});
