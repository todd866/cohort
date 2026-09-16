'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { getQueueSize, subscribeOutbox } from '@/lib/outbox';
import {
  OFFLINE_REVIEW_PROGRESS_EVENT,
  readOfflineReviewProgress,
} from '@/lib/offline/progress';
import {
  clearReviewBootstrapSafety,
  markReviewBootstrapClean,
  markReviewBootstrapDirty,
} from '@/lib/review/bootstrap-safety';

/**
 * Maintains the server-visible proof required before a page request may
 * assemble a delivery batch. Queue/tombstone writes mark it dirty
 * synchronously; this observer is the only place that promotes it back to
 * clean after both durable stores agree.
 */
export function ReviewBootstrapSafetyWarm() {
  const { data: session, status } = useSession();
  const ownerKey = session?.user?.id ?? null;

  useEffect(() => {
    if (status !== 'authenticated' || !ownerKey) {
      clearReviewBootstrapSafety();
      return;
    }

    const sync = () => {
      const hasQueuedReviews = getQueueSize('review', ownerKey) > 0;
      const hasTombstones =
        (readOfflineReviewProgress(ownerKey)?.tombstones.length ?? 0) > 0;
      if (hasQueuedReviews || hasTombstones) {
        markReviewBootstrapDirty(ownerKey);
      } else {
        markReviewBootstrapClean(ownerKey);
      }
    };

    sync();
    const unsubscribeOutbox = subscribeOutbox(sync);
    window.addEventListener(OFFLINE_REVIEW_PROGRESS_EVENT, sync);
    return () => {
      unsubscribeOutbox();
      window.removeEventListener(OFFLINE_REVIEW_PROGRESS_EVENT, sync);
    };
  }, [ownerKey, status]);

  return null;
}
