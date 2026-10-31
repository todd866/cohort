/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AboutPage from './page';

const mocks = vi.hoisted(() => ({ host: 'cohort.md' }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: mocks.host }),
}));

async function renderAbout() {
  return render(await AboutPage());
}
import { resolveSourceRepositoryUrl } from '@/lib/source-repository';

describe('AboutPage source repository link', () => {
  beforeEach(() => {
    mocks.host = 'cohort.md';
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('omits a source CTA until an operator publishes a repository URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPOSITORY_URL', '');
    await renderAbout();

    expect(screen.queryByRole('link', { name: /source repository/i })).toBeNull();
    expect(screen.getByText(/has not yet published a source repository link/i))
      .toBeInTheDocument();
  });

  it('renders an explicitly configured HTTPS source repository', async () => {
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPOSITORY_URL', 'https://code.example.org/md3');
    await renderAbout();

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

  it('does not claim that an unconfigured public corpus is already embedded', async () => {
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPOSITORY_URL', '');
    await renderAbout();

    expect(screen.getByText(/Where an operator configures the embedding pipeline/i))
      .toBeInTheDocument();
    expect(screen.getByText(/initial public USMLE corpus does not require embeddings/i))
      .toBeInTheDocument();
  });

  it('states the alpha scope and rejects legacy capability claims', async () => {
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPOSITORY_URL', '');
    const { container } = await renderAbout();

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

  it('keeps the Cohort heading on the Cohort host', async () => {
    await renderAbout();
    expect(screen.getByRole('heading', { level: 1, name: /About md3 and Cohort/ }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to Step 1/ })).toHaveAttribute('href', '/usmle/step1');
  });

  it.each(['md3.info', 'www.md3.info', 'localhost:3000'])(
    'shows md3 copy with no Step 1 text on %s',
    async (host) => {
      mocks.host = host;
      const { container } = await renderAbout();
      expect(screen.getByRole('heading', { level: 1, name: /About md3/ })).toBeInTheDocument();
      expect(container.textContent).toMatch(/University of Sydney/);
      expect(container.textContent).toMatch(/not a predictor of exam results/i);
      expect(container.textContent).not.toMatch(/Step 1|Cohort|USMLE/i);
      expect(screen.getByRole('link', { name: /Back to review/ })).toHaveAttribute('href', '/');
    },
  );
});

it('describes the md3 product in metadata on the md3 host and the Step 1 alpha on cohort.md', async () => {
  const { generateMetadata } = await import('./page');
  mocks.host = 'md3.info';
  expect(String((await generateMetadata()).description)).toContain('University of Sydney');
  expect(String((await generateMetadata()).description)).not.toContain('Step 1');
  mocks.host = 'cohort.md';
  expect(String((await generateMetadata()).description)).toContain('Step 1 alpha');
});
