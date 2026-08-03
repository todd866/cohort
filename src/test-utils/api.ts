/**
 * Shared test helpers for API route tests.
 *
 * Extracts common patterns duplicated across 6+ test files.
 */
import type { Session } from 'next-auth';
import type { NextRequest } from 'next/server';

/** Cast a standard Request to NextRequest for route handler tests. */
export function asNextRequest(request: Request): NextRequest {
  return request as unknown as NextRequest;
}

/** Build a minimal NextAuth Session for a given userId. */
export function sessionForUser(userId: string): Session {
  return { user: { id: userId } } as unknown as Session;
}
