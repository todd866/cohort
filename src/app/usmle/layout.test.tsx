/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import USMLELayout, { metadata } from './layout';

describe('USMLELayout', () => {
  it('renders the public USMLE surface with trademark notice and fork CTA', async () => {
    const layout = await USMLELayout({ children: <p>Open Step 1</p> });

    render(layout);
    expect(screen.getByText('Open Step 1')).toBeInTheDocument();
    expect(screen.getByText(/USMLE® is a registered trademark/i)).toHaveTextContent(
      /independent and is not affiliated with or endorsed/i,
    );
    expect(screen.getByText(/USMLE® is a registered trademark/i)).toHaveTextContent(
      /original questions, not recalled exam items/i,
    );
    expect(screen.getByRole('link', { name: /Fork on GitHub/i })).toHaveAttribute(
      'href',
      'https://github.com/todd866/cohort',
    );
    expect(screen.getByText(/Clone or fork the cohort repo/i)).toBeInTheDocument();
  });

  it('describes a public FOSS corpus without admin-only framing', () => {
    expect(metadata.title).toBe('USMLE study - cohort.md');
    expect(metadata.description).toMatch(/Public FOSS Step 1/i);
    expect(metadata.description).toMatch(/fork the open corpus on GitHub/i);
    expect(metadata.description).not.toMatch(/admin-only/i);
  });
});
