// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReviewItem } from '@/components/review/hooks/types';
import { bindVerifiedOfflineOwner, clearOfflineOwner } from '@/lib/offline/owner';
import { chooseReviewImage, clearImageChoiceHistory, readImageChoiceHistory, rememberReviewImage, reviewImageChoices } from './image-choices';

const meta = { class: 'diagram', showWhen: 'after-reveal', accessTier: 'public', altPolicy: 'generic', attributionText: 'MIT' } as const;
const original = { imageKey: '/figures/originals/new.png', imageUrl: '/figures/originals/new.png', imageCaption: 'New teaching diagram', imageRole: null, imageMeta: meta };
const item: ReviewItem = { type: 'card', id: 'one', rotation: 'cah', imageKey: '/figures/old.png', imageUrl: 'https://signed/old',
  imageCaption: 'Existing caption', imageMeta: { ...meta, accessTier: 'copyright-required' }, imageAlternatives: [original] };

beforeEach(() => { localStorage.clear(); clearOfflineOwner(); });
describe('additive image choice', () => {
  it('uses the new choice initially while retaining the existing image and caption', () => {
    const selected = chooseReviewImage(item);
    expect(selected.imageKey).toBe(original.imageKey);
    expect(selected.imageAlternatives).toEqual([
      { imageKey: item.imageKey, imageUrl: item.imageUrl, imageCaption: item.imageCaption, imageRole: null, imageMeta: item.imageMeta }, original,
    ]);
    expect(item.imageKey).toBe('/figures/old.png');
  });
  it('rotates between eligible old and new images, and holds the choice within an encounter', () => {
    expect(chooseReviewImage(item, original.imageKey).imageKey).toBe(item.imageKey);
    expect(chooseReviewImage(item, item.imageKey!).imageKey).toBe(original.imageKey);
    expect(chooseReviewImage(item, original.imageKey, original.imageKey).imageKey).toBe(original.imageKey);
  });
  it('allows a previously imageless item to use its reviewed diagram', () => {
    expect(chooseReviewImage({ ...item, imageUrl: null, imageKey: null, imageMeta: undefined }).imageKey).toBe(original.imageKey);
  });
  it('does not revive a denied scalar key and drops a held choice no longer allowed', () => {
    const lowerTier = { ...item, imageUrl: null, imageKey: null, imageMeta: undefined };
    expect(chooseReviewImage(lowerTier, undefined, item.imageKey!).imageKey).toBe(original.imageKey);
    expect(reviewImageChoices(lowerTier)).toEqual([original]);
  });
  it('never rotates explicit or inferred diagnostic prompts', () => {
    const explicit = { ...item, imageRole: 'prompt' as const };
    expect(chooseReviewImage(explicit)).toBe(explicit);
    const inferred = { ...item, imageMeta: { ...meta, class: 'diagnostic' as const, showWhen: 'always' as const } };
    expect(chooseReviewImage(inferred)).toBe(inferred);
  });
  it('deduplicates choices and rejects an alternative that could appear before reveal', () => {
    const invalid = { ...original, imageKey: '/figures/unsafe.png', imageMeta: { ...meta, showWhen: 'always' as const } };
    expect(reviewImageChoices({ ...item, imageAlternatives: [original, original, invalid] })).toHaveLength(2);
  });
  it('retains an offline primary whose signed URL was intentionally removed', () => {
    const selected = chooseReviewImage({ ...item, imageUrl: null }, original.imageKey);
    expect(selected.imageKey).toBe(item.imageKey);
    expect(selected.imageUrl).toBeNull();
  });
  it('records only the matching device owner and clears the bounded history on logout', () => {
    bindVerifiedOfflineOwner('owner-a');
    rememberReviewImage('owner-a', chooseReviewImage(item));
    expect(readImageChoiceHistory('owner-a')).toEqual({ 'card:one': original.imageKey });
    expect(readImageChoiceHistory('owner-b')).toEqual({});
    rememberReviewImage('owner-b', chooseReviewImage(item, original.imageKey));
    expect(readImageChoiceHistory('owner-a')).toEqual({ 'card:one': original.imageKey });
    clearImageChoiceHistory();
    expect(readImageChoiceHistory('owner-a')).toEqual({});
  });
});
