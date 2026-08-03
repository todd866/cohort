/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import USMLELayout, { metadata } from './layout';

describe('USMLELayout', () => {
  it('renders the public USMLE surface with trademark notice', async () => {
    const layout = await USMLELayout({ children: <p>Open Step 1</p> });

    render(layout);
    expect(screen.getByText('Open Step 1')).toBeInTheDocument();
    expect(screen.getByText(/USMLE® is a registered trademark/i)).toHaveTextContent(
      /independent and is not affiliated with or endorsed/i,
    );
    expect(screen.getByText(/USMLE® is a registered trademark/i)).toHaveTextContent(
      /original questions, not recalled exam items/i,
    );
    expect(screen.getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      'https://github.com/todd866/md3-foss',
    );
  });

  it('describes an early public open corpus without admin-only framing', () => {
    expect(metadata.title).toBe('USMLE study - MD3');
    expect(metadata.description).toMatch(/Public early open corpus/i);
    expect(metadata.description).toMatch(/25 original/i);
    expect(metadata.description).toMatch(/MCQs/i);
    expect(metadata.description).not.toMatch(/admin-only/i);
  });
});
