/**
 * "No videos" and "No images" (owner, 29 Oct 2026: "I really need 'no videos'
 * and/or 'no images'").
 *
 * Each changes WHAT is served, not only how it looks:
 *
 *  - An item whose clip or picture IS the question cannot be answered without
 *    it, so it is excluded from the queue (`itemExcludedByMediaPreferences`).
 *  - Media that only follows the answer is simply not rendered
 *    (`withoutHiddenMedia`); the card works from its text.
 *
 * Client-safe leaf. The server applies the exclusion in every pool path and
 * stamps cached queues with `reviewMediaFingerprint`; the client applies the
 * same predicate to anything it already holds (the offline pack, a batch in
 * flight when the toggle changed).
 *
 * Stored per learner in `User.experience.review` with a revision, beside the
 * other learner-chosen experience settings. A guest's choice lives on the
 * device and rides on each session request as `hide=`.
 */
import { itemImageIsPrompt } from '@/lib/figures/prompt-policy';
import type { ReviewMedia } from '@/lib/review/review-intent';

export interface ReviewMediaPreferences {
  hideVideos: boolean;
  hideImages: boolean;
}

/** The stored form: `rev` orders writes across devices; 0 means never chosen. */
export interface StoredReviewMediaPreferences extends ReviewMediaPreferences {
  rev: number;
}

export const DEFAULT_REVIEW_MEDIA_PREFERENCES: Readonly<ReviewMediaPreferences> = Object.freeze({
  hideVideos: false,
  hideImages: false,
});

export function hasMediaExclusions(preferences: ReviewMediaPreferences | null | undefined): boolean {
  return Boolean(preferences?.hideVideos || preferences?.hideImages);
}

/**
 * Stamped on every cached queue item. The default is the empty string so a
 * queue built before this existed (no stamp) still matches a learner who has
 * never chosen.
 */
export function reviewMediaFingerprint(preferences: ReviewMediaPreferences | null | undefined): string {
  if (!preferences) return '';
  return [preferences.hideImages ? 'no-image' : null, preferences.hideVideos ? 'no-video' : null]
    .filter(Boolean)
    .join('+');
}

/** Wire value for `hide=`. `none` is an explicit choice, unlike an absent parameter. */
export function reviewMediaHideParam(preferences: ReviewMediaPreferences): string {
  const kinds = [preferences.hideVideos ? 'video' : null, preferences.hideImages ? 'image' : null].filter(Boolean);
  return kinds.length ? kinds.join(',') : 'none';
}

/** Null when absent or malformed: the caller then uses the stored setting. */
export function parseReviewMediaHideParam(raw: string | null | undefined): ReviewMediaPreferences | null {
  if (!raw) return null;
  if (raw === 'none') return { ...DEFAULT_REVIEW_MEDIA_PREFERENCES };
  const kinds = raw.split(',');
  if (kinds.length > 2 || kinds.some((kind) => kind !== 'video' && kind !== 'image')) return null;
  return { hideVideos: kinds.includes('video'), hideImages: kinds.includes('image') };
}

export function normalizeReviewMediaPreferences(value: unknown): StoredReviewMediaPreferences {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const rev = typeof record.rev === 'number' && Number.isSafeInteger(record.rev) && record.rev > 0 ? record.rev : 0;
  return {
    hideVideos: record.hideVideos === true,
    hideImages: record.hideImages === true,
    rev,
  };
}

/** Read `User.experience.review`. Never throws; anything unreadable is the default. */
export function reviewMediaPreferencesFromExperience(experience: unknown): StoredReviewMediaPreferences {
  const record = experience && typeof experience === 'object' && !Array.isArray(experience)
    ? (experience as Record<string, unknown>)
    : {};
  return normalizeReviewMediaPreferences(record.review);
}

/**
 * An explicit media mode is a narrower, deliberate request: "Videos only"
 * with No videos on would otherwise serve nothing. The mode wins for its kind.
 */
export function effectiveReviewMediaPreferences(
  preferences: ReviewMediaPreferences,
  media: ReviewMedia | undefined,
): ReviewMediaPreferences {
  if (media === 'any') return { ...DEFAULT_REVIEW_MEDIA_PREFERENCES };
  return {
    hideVideos: preferences.hideVideos && media !== 'video',
    hideImages: preferences.hideImages && media !== 'image',
  };
}

/** The fields the predicates read, shared by server items and client review items. */
export interface MediaBearingItem {
  type?: string;
  front?: string | null;
  stem?: string | null;
  imageUrl?: string | null;
  imageKey?: string | null;
  imageRole?: string | null;
  imageMeta?: { class?: string; showWhen?: string } | null;
  imageCaption?: string | null;
  imageAlternatives?: unknown;
  clip?: unknown;
  clipRole?: string | null;
  clipCaption?: string | null;
  contextImageUrl?: string | null;
  promptFigure?: unknown;
  publicAnatomyMedia?: { role?: string } | null;
}

/** Decided on the role, not on a resolved URL, so a cached row cannot slip through. */
export function itemNeedsPromptVideo(item: MediaBearingItem): boolean {
  return item.clipRole === 'prompt';
}

/** Same predicate the review panes use to put a picture above the question. */
export function itemNeedsPromptImage(item: MediaBearingItem): boolean {
  if (item.promptFigure) return true;
  if (item.publicAnatomyMedia?.role === 'prompt') return true;
  // A linked group (ECG, ABG) is read off its context image.
  if (item.type === 'group' && item.contextImageUrl) return true;
  if (!(item.imageUrl || item.imageKey)) return false;
  return itemImageIsPrompt(item.imageRole, item.imageMeta, item.front ?? item.stem);
}

export function itemExcludedByMediaPreferences(
  item: MediaBearingItem,
  preferences: ReviewMediaPreferences | null | undefined,
): boolean {
  if (!preferences) return false;
  return (preferences.hideVideos && itemNeedsPromptVideo(item))
    || (preferences.hideImages && itemNeedsPromptImage(item));
}

/**
 * Remove after-reveal media for display. Prompt media is never stripped: an
 * item that needs it is excluded instead. Returns the same object when there
 * is nothing to remove, so memoised consumers do not re-render.
 */
export function withoutHiddenMedia<T extends MediaBearingItem>(
  item: T,
  preferences: ReviewMediaPreferences | null | undefined,
): T {
  if (!hasMediaExclusions(preferences)) return item;
  let next: T = item;
  if (preferences!.hideVideos && item.clip && !itemNeedsPromptVideo(item)) {
    next = { ...next, clip: null, clipCaption: null };
  }
  if (preferences!.hideImages && !itemNeedsPromptImage(item)) {
    if (item.imageUrl || item.imageKey) {
      next = {
        ...next,
        imageUrl: null,
        imageKey: null,
        imageCaption: null,
        imageMeta: undefined,
        imageAlternatives: undefined,
      };
    }
    if (item.publicAnatomyMedia) next = { ...next, publicAnatomyMedia: undefined };
  }
  return next;
}
