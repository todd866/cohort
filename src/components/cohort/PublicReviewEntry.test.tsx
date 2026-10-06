/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicReviewEntry } from './PublicReviewEntry';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), client: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: 'authenticated', data: { user: { id: 'user-1' } } }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/anatomy', useSearchParams: () => new URLSearchParams() }));
vi.mock('./PublicReviewClient', () => ({ PublicReviewClient: (props: { topicId: string | null }) => { mocks.client(props); return <p data-testid="controller">topic:{props.topicId}</p>; } }));

const anatomyTopic = {
  id: 'module-anatomy', label: 'Anatomy', aliases: [], searchIntents: [], learningOutcomes: [], modalities: ['text'], eligibleItemCount: 12, eligibleAssetCount: 3,
};

describe('PublicReviewEntry', () => {
  beforeEach(() => {
    mocks.client.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 200 }));
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      profile: { hookCompletedAt: '2026-10-01T00:00:00.000Z', explicit: { experience: 'medical-student' } },
      deep: false, searchTopics: [anatomyTopic], demandTopics: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });

  it('maps the anatomy route to the admitted anatomy topic', async () => {
    render(<PublicReviewEntry />);
    await waitFor(() => expect(screen.getByTestId('controller')).toHaveTextContent('topic:module-anatomy'));
    expect(mocks.client).toHaveBeenCalledWith(expect.objectContaining({ topicId: 'module-anatomy' }));
  });
});
