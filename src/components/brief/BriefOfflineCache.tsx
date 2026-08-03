'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { offlineUserKey, saveBrief } from '@/lib/offline/pack';
import { bindOfflineOwner } from '@/lib/offline/device-state';
import { isOfflineOwnerCurrent } from '@/lib/offline/owner';

/**
 * Keeps the brief on the device so `/offline` can render it with no signal.
 *
 * The brief is a build-time JSON import rendered by a server component, so
 * unlike the review feed there is nothing to fetch and nothing to schedule — the
 * only reason it cannot already work offline is that reaching the page requires
 * the server. Writing it into the pack on each authenticated visit closes that
 * gap without a new API surface.
 */
export function BriefOfflineCache({
  snapshot,
  userKey,
}: {
  snapshot: unknown;
  userKey: string | null;
}) {
  const { data: session, status: sessionStatus } = useSession();
  const authenticatedUserKey =
    sessionStatus === 'authenticated' ? offlineUserKey(session?.user) : null;

  useEffect(() => {
    // `userKey` was rendered by the server. It can be stale by the time this
    // client effect hydrates (or resumes from the back/forward cache), so the
    // live next-auth identity must agree before this component is allowed to
    // change the device owner or persist a personal brief.
    if (!userKey || !authenticatedUserKey || authenticatedUserKey !== userKey) return;

    const lease = bindOfflineOwner(authenticatedUserKey);
    if (!isOfflineOwnerCurrent(lease)) return;
    saveBrief(authenticatedUserKey, snapshot);
  }, [authenticatedUserKey, snapshot, userKey]);

  return null;
}
