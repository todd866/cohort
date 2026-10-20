'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LoadingSkeleton } from '@/components/review/LoadingSkeleton';
import { UnifiedReview } from '@/components/review/UnifiedReview';
import type { ReviewItem } from '@/components/review/hooks/types';
import { reviewSessionScopeKey } from '@/lib/review/session-scope';
import { parseDayRange } from '@/lib/stats/calendar-grid';

/**
 * A review session of exactly the cards and questions from a calendar day
 * or range, or the cards due on a future day. The server reads the
 * signed-in learner only; this component just hands that batch to the
 * existing review loop and stops it from fetching a normal queue.
 */
export function ScopedDayReview({
  replay,
  due,
  userId,
  pending,
}: {
  replay: string | null;
  due: string | null;
  userId: string | null;
  pending: boolean;
}) {
  const mode = due ? 'due' : 'answered';
  const range = parseDayRange(due ?? replay);
  const from = range?.from ?? '';
  const to = range?.to ?? '';
  const requestKey = `${userId ?? ''}|${mode}|${from}|${to}`;
  const [loaded, setLoaded] = useState<{ key: string; items: ReviewItem[] } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to || !userId) return;
    const controller = new AbortController();
    const key = requestKey;
    const params = new URLSearchParams({ from, to, mode });
    void fetch(`/api/study/day-replay?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const body = await response.json() as { items?: ReviewItem[] };
        if (!controller.signal.aborted) setLoaded({ key, items: Array.isArray(body.items) ? body.items : [] });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setFailedKey(key);
      });
    return () => controller.abort();
  }, [from, to, mode, userId, requestKey]);

  const items = loaded?.key === requestKey ? loaded.items : null;
  const failed = failedKey === requestKey;

  if (pending) return <LoadingSkeleton variant="page" />;
  if (!userId) {
    return (
      <Link href="/api/auth/signin" className="inline-flex min-h-9 items-center px-4 text-sm text-[var(--md-primary)]">
        Sign in
      </Link>
    );
  }
  if (!range || failed) {
    return <p role="alert" className="px-4 py-6 text-sm text-[var(--md-error)]">Could not open that day.</p>;
  }
  if (!items) return <LoadingSkeleton variant="page" />;
  if (items.length === 0) {
    return <p className="px-4 py-6 text-sm tabular-nums text-[var(--md-on-surface)]">0 reviews</p>;
  }
  const rotations = [...new Set(items.map((item) => item.rotation).filter(Boolean))];
  const replayKey = `${mode}:${range.from}..${range.to}`;
  return (
    <UnifiedReview
      rotations={rotations}
      feedMode="mixed"
      boundedQueue
      replayKey={replayKey}
      initialBatch={{
        ownerKey: userId,
        scopeKey: reviewSessionScopeKey({ rotations, feedMode: 'mixed', replay: replayKey }),
        items,
        newRemaining: null,
      }}
    />
  );
}
