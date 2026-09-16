import { NextResponse } from 'next/server';
import { getMove, getPassage, passageMoves } from '@/lib/gamsat/corpus';

/**
 * One passage, plus the definitions of every move its questions demand.
 *
 * The correct option travels with the payload. That is deliberate and not a
 * leak: the corpus is CC BY 4.0 and published on GitHub, so there is no answer
 * key to protect, and grading client-side is what lets a guest study with no
 * account and no server round-trip per answer.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const passage = getPassage(decodeURIComponent(id));
  if (!passage) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const moves = passageMoves(passage)
    .map((moveId) => getMove(moveId))
    .filter((move): move is NonNullable<typeof move> => move !== null);

  return NextResponse.json(
    { passage, moves },
    { headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' } },
  );
}
