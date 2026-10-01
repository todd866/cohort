import { NextResponse } from 'next/server';
import { requireAuthOrGuest } from '@/lib/api-utils';

/**
 * Establish the caller's study identity, creating a guest if there is none.
 *
 * md3.info had no such seam. Only three routes could mint a guest
 * (`usmle/step1/session`, `usmle/step1/progress`, `study/focused-session`), all
 * on the cohort.md path, and no page or middleware called them. So a first-time
 * visitor held no cookie, every study endpoint answered 401 "load the app first
 * to establish a session", and `/review` sat on "Preparing review…" forever.
 * Loading the app WAS the thing that failed to establish the session.
 *
 * `requireAuthOrGuest` owns the policy: it returns an existing session or guest
 * untouched, and rate-limits creation per IP bucket so a drive-by crawler
 * cannot mint a `User` row per request. This route deliberately adds nothing to
 * that — it exists so the client has one honest place to ask.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireAuthOrGuest(request);
  // Refusals (notably the guest-creation rate limit) pass through unchanged.
  // Reporting `ready: true` here would hand the client a green light while it
  // still has no identity, reproducing the original silent failure.
  if (auth.response) return auth.response;

  return NextResponse.json(
    { ready: true, isGuest: auth.isGuest },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
