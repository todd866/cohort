import { NextResponse } from 'next/server';
import { corpusStats, corpusSummaries } from '@/lib/gamsat/corpus';

/**
 * The selection index: passage id, domain and demanded moves. Small by design —
 * the client fetches this, runs move-weighted selection against its local
 * mastery state, then requests the one passage it picked.
 */
export function GET() {
  return NextResponse.json(
    { passages: corpusSummaries(), stats: corpusStats() },
    // Static content: cacheable for a long time, revalidated by deploy.
    { headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' } },
  );
}
