/**
 * /favicon.ico — browsers and crawlers request it by convention, ignoring the
 * <link rel="icon"> that icon.tsx generates. Send them to that same artwork
 * (host-aware: MD3 or Cohort) rather than keeping a second binary copy.
 * Not cached for long: the icon varies by host.
 */
export function GET() {
  return new Response(null, {
    status: 307,
    headers: { Location: '/icon', 'Cache-Control': 'public, max-age=3600' },
  });
}
