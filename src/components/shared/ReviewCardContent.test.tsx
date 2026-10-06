/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReviewCardContent } from './ReviewCardContent';

describe('ReviewCardContent', () => {
  it('keeps prompt media between stem and answer content', () => {
    render(<ReviewCardContent layout="prompt" stem={<p>stem</p>} media={<img alt="figure" />} reveal={<button>Reveal</button>} answer={<p>answer</p>} links={<p>links</p>} />);
    expect(screen.getByText('stem')).toBeInTheDocument();
    expect(screen.getByAltText('figure')).toBeInTheDocument();
    expect(screen.getByText('answer')).toBeInTheDocument();
    expect(screen.getByText('links')).toBeInTheDocument();
  });
});
