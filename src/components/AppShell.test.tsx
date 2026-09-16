/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

const mockPathname = vi.hoisted(() => vi.fn(() => '/'));

vi.mock('next/navigation', () => ({
  usePathname: mockPathname,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    prefetch,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
    className?: string;
  }) => (
    <a
      href={href}
      data-prefetch={prefetch === false ? 'false' : undefined}
      {...props}
    >
      {children}
    </a>
  ),
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
    mockPathname.mockReturnValue('/profile');
    render(<AppShell><p>Review content</p></AppShell>);

    expect(screen.getByRole('link', { name: 'Skip to main content' }))
      .toHaveAttribute('href', '#main-content');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('data-prefetch', 'false');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('data-prefetch', 'false');
  });

  it.each(['/', '/review', '/study/example', '/x/cockpit'])('keeps %s focused on study with a skip target', (pathname) => {
    mockPathname.mockReturnValue(pathname);
    render(<AppShell><p>Special layout</p></AppShell>);

    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.queryByRole('link', { name: 'Privacy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Terms' })).not.toBeInTheDocument();
  });

  it('keeps an immersive route immersive and removes global navigation', () => {
    mockPathname.mockReturnValue('/videos');
    render(<AppShell><p>Immersive stage</p></AppShell>);

    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Privacy' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveClass('h-[100svh]', 'overflow-hidden');
  });
});
