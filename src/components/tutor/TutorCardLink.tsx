'use client';

import { useContext, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SessionContext } from 'next-auth/react';
import { isCohortHostname } from '@/lib/institution';

/**
 * "Ask tutor" from a revealed card: a plain link into the tutor thread carrying
 * the card and the surface, so the question is asked ABOUT this card without an
 * input box ever sitting on the review surface, where it would take the
 * space / 1–4 / S grading keys.
 *
 * Renders nothing unless the viewer can actually use the tile. The tile is
 * admin-gated for now, and a link that everyone sees but only one person can
 * follow is the silent-404 shape this repo has already been bitten by. This
 * component ships in the public distribution while the tutor itself does not,
 * so it also refuses the public host — the same test protectPrivateMd3Api
 * applies on the server — rather than link to a route that build never had.
 */
const subscribeToNothing = () => () => {};
const readHostname = () => window.location.hostname;
const readServerHostname = () => null;

export function TutorCardLink({ cardId }: { cardId: string }) {
  // The context, not useSession(): the hook throws outside a SessionProvider,
  // and this renders inside every surface that shows a card — including
  // tests and previews that mount CardItemView with no provider at all. No
  // provider means no session, which means no link.
  const session = useContext(SessionContext);
  const data = session?.data ?? null;
  const status = session?.status ?? 'unauthenticated';
  const pathname = usePathname();
  // Server snapshot is null and the client's is the real host, so the first
  // client render matches the server and React swaps in the host afterwards —
  // without a setState-in-effect, which the compiler lint rejects.
  const host = useSyncExternalStore(subscribeToNothing, readHostname, readServerHostname);

  // The session callback sets isAdmin (see the next-auth augmentation in
  // src/lib/auth.ts); read it structurally so the scripts tsconfig, which does
  // not load that augmentation, types this file the same way the app does.
  const isAdmin = (data?.user as { isAdmin?: boolean } | undefined)?.isAdmin === true;
  if (status !== 'authenticated' || !isAdmin) return null;
  if (host === null || isCohortHostname(host)) return null;

  const params = new URLSearchParams({ cardId, from: pathname ?? '/review' });
  return (
    <Link
      href={`/tutor?${params.toString()}`}
      className="text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)] opacity-60 hover:opacity-100"
    >
      Ask tutor →
    </Link>
  );
}
