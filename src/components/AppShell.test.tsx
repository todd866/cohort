/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

const mockPathname = vi.hoisted(() => vi.fn(() => '/'));

vi.mock('next/navigation', () => ({
  usePathname: mockPathname,
}));

vi.mock('@/components/Navigation', () => ({
  Navigation: () => <nav aria-label="Main navigation" />,
}));

vi.mock('@/components/ConnectionBanner', () => ({
  ConnectionBanner: () => null,
}));

describe('AppShell accessibility landmarks', () => {
  beforeEach(() => {
    mockPathname.mockReturnValue('/');
  });

  it('provides a focusable skip target for the main landmark', () => {
    render(<AppShell><p>Review content</p></AppShell>);

    expect(screen.getByRole('link', { name: 'Skip to main content' }))
      .toHaveAttribute('href', '#main-content');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  });

  it.each(['/study/example', '/x/cockpit'])('keeps the skip target on %s layouts', (pathname) => {
    mockPathname.mockReturnValue(pathname);
    render(<AppShell><p>Special layout</p></AppShell>);

    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });
});
