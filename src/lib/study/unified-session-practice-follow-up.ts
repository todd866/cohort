import type { NextResponse } from 'next/server';
import type { SessionContext } from './unified-session-types';

/** Public builds do not serve institution-specific practice-exam retests. */
export async function tryPracticeFollowUpSession(
  _ctx: SessionContext,
  _tryScaffold?: () => Promise<NextResponse | null>,
): Promise<NextResponse | null> {
  return null;
}
