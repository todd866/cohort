import type { ClientImageMeta, ResolvedImageAlternative } from '@/lib/figures/types';
import { readOfflineOwner } from '@/lib/offline/owner';

export const IMAGE_CHOICE_HISTORY_KEY = 'md3:image-choice-history:v1';
const MAX_HISTORY = 512;

/** Image selection and device history do not depend on a particular review UI. */
export interface ImageChoiceItem {
  type: string;
  id: string;
  imageKey?: string | null;
  imageUrl?: string | null;
  imageCaption?: string | null;
  imageRole?: string | null;
  imageMeta?: ClientImageMeta | null;
  imageAlternatives?: ResolvedImageAlternative[];
}

export function reviewImageChoices(item: ImageChoiceItem): ResolvedImageAlternative[] {
  if (item.imageRole === 'prompt' || (item.imageMeta?.class === 'diagnostic'
    && item.imageMeta.showWhen !== 'after-reveal')) return [];
  const choices: ResolvedImageAlternative[] = [];
  if (item.imageKey && item.imageMeta && (item.imageUrl || item.imageMeta)) {
    choices.push({ imageKey: item.imageKey, imageUrl: item.imageUrl ?? '',
      imageCaption: item.imageCaption ?? '', imageRole: null, imageMeta: item.imageMeta });
  }
  for (const alternative of item.imageAlternatives ?? []) {
    if (alternative.imageRole !== null || alternative.imageMeta?.showWhen !== 'after-reveal'
      || !alternative.imageKey || choices.some(c => c.imageKey === alternative.imageKey)) continue;
    choices.push(alternative);
  }
  return choices;
}

/** Rotate within this item's reviewed choices; do not change the underlying source item. */
export function chooseReviewImage<T extends ImageChoiceItem>(item: T, lastKey?: string, heldKey?: string): T {
  if (!item.imageAlternatives?.length) return item;
  const choices = reviewImageChoices(item);
  if (!choices.length) return item;
  const held = choices.find(c => c.imageKey === heldKey);
  const previous = choices.findIndex(c => c.imageKey === lastKey);
  const chosen = held ?? choices[previous >= 0 ? (previous + 1) % choices.length : choices.length - 1];
  return { ...item, ...chosen, imageUrl: chosen.imageUrl || null, imageAlternatives: choices };
}

export function readImageChoiceHistory(ownerKey: string | null): Record<string, string> {
  if (!ownerKey || readOfflineOwner()?.ownerKey !== ownerKey) return {};
  try {
    const value = JSON.parse(localStorage.getItem(IMAGE_CHOICE_HISTORY_KEY) ?? 'null');
    if (value?.schemaVersion !== 1 || value.ownerKey !== ownerKey || !Array.isArray(value.entries)) return {};
    return Object.fromEntries(value.entries.slice(-MAX_HISTORY).filter((entry: unknown) => Array.isArray(entry)
      && entry.length === 2 && entry.every(v => typeof v === 'string' && v.length < 1_000)));
  } catch { return {}; }
}

export function rememberReviewImage(ownerKey: string | null, item: ImageChoiceItem): void {
  if (!ownerKey || readOfflineOwner()?.ownerKey !== ownerKey || !item.imageAlternatives?.length || !item.imageKey) return;
  const history = readImageChoiceHistory(ownerKey);
  const key = `${item.type}:${item.id}`;
  if (history[key] === item.imageKey) return;
  delete history[key];
  history[key] = item.imageKey;
  try {
    localStorage.setItem(IMAGE_CHOICE_HISTORY_KEY, JSON.stringify({ schemaVersion: 1, ownerKey,
      entries: Object.entries(history).slice(-MAX_HISTORY) }));
  } catch { /* Storage denial only removes cross-session rotation memory. */ }
}

export function clearImageChoiceHistory(): void {
  try { localStorage.removeItem(IMAGE_CHOICE_HISTORY_KEY); } catch { /* Storage unavailable. */ }
}
