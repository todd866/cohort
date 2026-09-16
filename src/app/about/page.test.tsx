/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AboutPage from './page';
import { resolveSourceRepositoryUrl } from '@/lib/source-repository';

describe('AboutPage source repository link', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('omits a source CTA until an operator publishes a repository URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPOSITORY_URL', '');
    render(<AboutPage />);

    expect(screen.queryByRole('link', { name: /source repository/i })).toBeNull();
    expect(screen.getByText(/has not yet published a source repository link/i))
      .toBeInTheDocument();
  });

  it('renders an explicitly configured HTTPS source repository', () => {
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPOSITORY_URL', 'https://code.example.org/md3');
    render(<AboutPage />);

    expect(screen.getByRole('link', { name: /source repository/i }))
      .toHaveAttribute('href', 'https://code.example.org/md3');
    expect(screen.getByText(/reviewed source distribution is available/i))
      .toBeInTheDocument();
  });

  it.each([
    'http://code.example.org/md3',
    'javascript:alert(1)',
    'https://user:password@code.example.org/md3',
  ])('rejects an unsafe source URL: %s', (value) => {
    expect(resolveSourceRepositoryUrl(value)).toBeNull();
  });

  it('does not claim that an unconfigured public corpus is already embedded', () => {
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPOSITORY_URL', '');
    render(<AboutPage />);

    expect(screen.getByText(/Where an operator configures the embedding pipeline/i))
      .toBeInTheDocument();
    expect(screen.getByText(/initial public USMLE corpus does not require embeddings/i))
      .toBeInTheDocument();
  });

  it('states the alpha scope and rejects legacy capability claims', () => {
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPOSITORY_URL', '');
    const { container } = render(<AboutPage />);

    expect(screen.getByText(/current open alpha is a deliberately small vertical slice/i))
      .toBeInTheDocument();
    expect(screen.getByText(/25 original questions across six domains/i))
      .toBeInTheDocument();
    expect(screen.getByText(/not a comprehensive Step 1 bank/i))
      .toBeInTheDocument();
    expect(screen.getByText(/not affiliated with, endorsed by, or sponsored/i))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Official USMLE program overview/i }))
      .toHaveAttribute('href', 'https://www.usmle.org/about-usmle');
    expect(container.textContent).not.toMatch(
      /Never schedules reviews after your exam|Increases frequency in the final week|Ensures complete curriculum coverage|Every interaction feeds your knowledge state/,
    );
  });
});
