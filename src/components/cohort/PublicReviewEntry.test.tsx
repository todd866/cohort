/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicReviewEntry } from './PublicReviewEntry';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), unified: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: 'authenticated', data: { user: { id: 'user-1' } } }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({push: vi.fn()}), usePathname: () => '/anatomy', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/review/UnifiedReview', () => ({ UnifiedReview: (props: { initialCohortTopicId?: string | null }) => { mocks.unified(props); return <p data-testid="controller">topic:{props.initialCohortTopicId}</p>; } }));

const anatomyTopic = {
  id: 'module-anatomy', label: 'Anatomy', aliases: [], searchIntents: [], learningOutcomes: [], modalities: ['text'], eligibleItemCount: 12, eligibleAssetCount: 3,
};

describe('PublicReviewEntry', () => {
  beforeEach(() => {
    mocks.unified.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      profile: { hookCompletedAt: '2026-10-01T00:00:00.000Z', explicit: { experience: 'medical-student' } },
      deep: false, searchTopics: [anatomyTopic], demandTopics: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });

  it('maps the anatomy route to the admitted anatomy topic', async () => {
    render(<PublicReviewEntry />);
    await waitFor(() => expect(screen.getByTestId('controller')).toHaveTextContent('topic:module-anatomy'));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.unified).toHaveBeenCalledWith(expect.objectContaining({
      initialCohortTopicId: 'module-anatomy',
      cohortSingleTurn: true,
      rotations: ['usmle-step1-open'],
      initialCohortSnapshot: expect.objectContaining({ publicGradedCount: 0 }),
    }));
  });
});
