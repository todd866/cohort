// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import type { ReviewItem } from '@/components/review/hooks/types';
import { bindVerifiedOfflineOwner, clearOfflineOwner, ensureOfflineOwner } from '@/lib/offline/owner';
import { readImageChoiceHistory } from '@/lib/review/image-choices';
import { useReviewImageChoices } from './useReviewImageChoices';

const meta = { class: 'diagram', showWhen: 'after-reveal', accessTier: 'public', altPolicy: 'generic', attributionText: 'MIT' } as const;
function item(id: string): ReviewItem { return { type: 'card', id, rotation: 'cah', imageKey: '/figures/old.png', imageUrl: '/figures/old.png', imageMeta: meta,
  imageAlternatives: [{ imageKey: `/figures/originals/${id}.png`, imageUrl: `/figures/originals/${id}.png`, imageCaption: 'Diagram', imageRole: null, imageMeta: meta }] }; }
beforeEach(() => { localStorage.clear(); clearOfflineOwner(); bindVerifiedOfflineOwner('owner-a'); });

it('prepares choices without advancing unseen items and keeps reveal/rerenders stable', () => {
  const items = [item('one'), item('two')];
  const { result, rerender } = renderHook(({ index }) => useReviewImageChoices(items, index, 'owner-a'), { initialProps: { index: 0 } });
  expect(result.current[0].imageKey).toBe('/figures/originals/one.png');
  expect(readImageChoiceHistory('owner-a')).toEqual({ 'card:one': '/figures/originals/one.png' });
  rerender({ index: 0 });
  expect(result.current[0].imageKey).toBe('/figures/originals/one.png');
  rerender({ index: 1 });
  expect(readImageChoiceHistory('owner-a')['card:two']).toBe('/figures/originals/two.png');
  rerender({ index: 0 });
  expect(result.current[0].imageKey).toBe('/figures/originals/one.png');
});

it('chooses the other image on a later encounter and isolates account changes', () => {
  const items = [item('one')];
  const first = renderHook(() => useReviewImageChoices(items, 0, 'owner-a'));
  expect(first.result.current[0].imageKey).toBe('/figures/originals/one.png');
  first.unmount();
  const second = renderHook(({ owner }) => useReviewImageChoices(items, 0, owner), { initialProps: { owner: 'owner-a' } });
  expect(second.result.current[0].imageKey).toBe('/figures/old.png');
  act(() => { bindVerifiedOfflineOwner('owner-b'); });
  second.rerender({ owner: 'owner-b' });
  expect(second.result.current[0].imageKey).toBe('/figures/originals/one.png');
});

it('waits until a future encounter is current before choosing against the last seen image', () => {
  const items = [
    { ...item('one'), serveDecisionId: 'first-delivery' },
    { ...item('one'), serveDecisionId: 'second-delivery' },
  ];
  const { result, rerender } = renderHook(({ index }) => useReviewImageChoices(items, index, 'owner-a'), {
    initialProps: { index: 0 },
  });
  expect(result.current[0].imageKey).toBe('/figures/originals/one.png');
  rerender({ index: 1 });
  expect(result.current[1].imageKey).toBe('/figures/old.png');
  rerender({ index: 0 });
  expect(result.current[0].imageKey).toBe('/figures/originals/one.png');
});

it('holds the selected image for fresh payload objects representing the same delivered encounter', () => {
  const { result, rerender } = renderHook(({ items }) => useReviewImageChoices(items, 0, 'owner-a'), {
    initialProps: { items: [{ ...item('one'), serveDecisionId: 'same-delivery' }] },
  });
  expect(result.current[0].imageKey).toBe('/figures/originals/one.png');
  rerender({ items: [{ ...item('one'), serveDecisionId: 'same-delivery' }] });
  expect(result.current[0].imageKey).toBe('/figures/originals/one.png');
});

it('keeps signed-out rotation memory in the current device-guest partition', () => {
  clearOfflineOwner();
  const guest = ensureOfflineOwner();
  renderHook(() => useReviewImageChoices([item('one')], 0, null));
  expect(readImageChoiceHistory(guest.ownerKey)).toEqual({ 'card:one': '/figures/originals/one.png' });
});

it('does not adopt a verified account implicitly when the caller has no owner', () => {
  renderHook(() => useReviewImageChoices([item('one')], 0, null));
  expect(readImageChoiceHistory('owner-a')).toEqual({});
});
