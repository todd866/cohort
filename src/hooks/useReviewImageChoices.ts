'use client';
import { useEffect, useState } from 'react';
import type { ReviewItem } from '@/components/review/hooks/types';
import { chooseReviewImage, readImageChoiceHistory, rememberReviewImage } from '@/lib/review/image-choices';
import { readOfflineOwner } from '@/lib/offline/owner';

/** One stable choice per delivered encounter. Only the current item advances local image memory. */
export function useReviewImageChoices(items: ReviewItem[], currentIndex: number, ownerKey: string | null): ReviewItem[] {
  const deviceOwner = readOfflineOwner();
  // Signed-out users may use only the device-guest partition implicitly.
  // A verified account must be supplied by the caller's display-owner gate.
  const historyOwnerKey = ownerKey ?? (deviceOwner?.verified === false ? deviceOwner.ownerKey : null);
  const owner = `${historyOwnerKey ?? 'guest'}:${deviceOwner?.generation ?? 0}`;
  const [memo, setMemo] = useState(() => ({ owner, choices: new Map<string, string>() }));
  let choices = memo.owner === owner ? memo.choices : new Map<string, string>();
  const history = readImageChoiceHistory(historyOwnerKey);
  const displayed: ReviewItem[] = [];
  for (const [index, item] of items.entries()) {
    const id = `${item.type}:${item.id}`;
    const encounter = `${id}:${item.serveDecisionId ?? item.batchId ?? item.sessionId ?? ''}`;
    const held = choices.get(encounter);
    // Future encounters must observe history when they become current, not
    // reserve the same choice as an earlier encounter still in this queue.
    // Image preparation separately prefetches every eligible raw choice.
    if (index !== currentIndex && held === undefined) {
      displayed.push(item);
      continue;
    }
    const selected = chooseReviewImage(item, history[id], held);
    if (selected.imageKey && selected !== item && held !== selected.imageKey) {
      choices = new Map(choices).set(encounter, selected.imageKey);
    }
    displayed.push(selected);
  }
  // Adjust this component's state before committing a newly visited encounter.
  // The guarded retry holds its choice before the history effect can advance it.
  if (memo.owner !== owner || memo.choices !== choices) setMemo({ owner, choices });
  const current = displayed[currentIndex];
  useEffect(() => {
    if (current) rememberReviewImage(historyOwnerKey, current);
  }, [current, historyOwnerKey]);
  return displayed;
}
