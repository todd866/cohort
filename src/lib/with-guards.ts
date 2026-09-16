/**
 * withGuards — a composable route wrapper for Next.js 16 App Router handlers.
 *
 * Today every API route hand-stacks the same early-return guard blocks
 * (auth via api-utils, optional rate-limit, a try/catch 500). That is opt-in
 * and copy-pasted, so coverage is silently incomplete — only 9 of 98 routes
 * are rate-limited and at least one (study/record) leaks raw error.message to
 * the client. This HOF folds the three orthogonal concerns — auth,
 * rate-limit, and error-sanitisation — into one wrapper that REUSES the
 * existing helpers (it does not replace them), so a route becomes:
 *
 *   export const POST = withGuards(handler, { auth: 'admin', rateLimit: {...} });
 *
 * Rate limits use the shared Postgres bucket in src/lib/rate-limit.ts, so the
 * limit is consistent across serverless instances.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  requireAuth,
  requireAdmin,
  requireAuthOrGuest,
  requireAuthOrExistingGuest,
  optionalAuth,
} from '@/lib/api-utils';
import { checkUserRateLimit, checkRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export type AuthMode =
  | 'required' // logged-in user; 401 otherwise
  | 'admin' // admin email; 401/403 otherwise
  | 'guest-ok' // session or freshly-created guest (read paths)
  | 'existing-guest' // session or existing guest cookie; 401 otherwise (write paths)
  | 'optional' // userId if logged in, else null; never short-circuits
  | 'public'; // no auth check at all (userId always null)

export interface GuardContext {
  /** Null only for 'optional' / 'public' callers who are unauthenticated. */
  userId: string | null;
  isGuest: boolean;
}

export interface RateLimitConfig {
  /** Namespacing label for the limit bucket. */
  name: string;
  limit: number;
  windowMs: number;
  /**
   * Key by client IP instead of userId. Forced on for anonymous callers
   * (no userId) regardless of this flag. Use for anti-spam on routes that
   * accept anonymous traffic (e.g. /api/help).
   */
  byIp?: boolean;
}

export interface GuardOptions {
  auth?: AuthMode;
  rateLimit?: RateLimitConfig;
  /** Label used in the sanitised-500 server log. */
  errorLabel?: string;
}

export type GuardedHandler<C = unknown> = (
  request: NextRequest,
  ctx: GuardContext,
  routeCtx: C,
) => Promise<Response> | Response;

type ResolvedAuth =
  | { userId: string | null; isGuest: boolean; response?: never }
  | { response: NextResponse; userId?: never; isGuest?: never };

async function resolveAuth(mode: AuthMode, request: NextRequest): Promise<ResolvedAuth> {
  switch (mode) {
    case 'required': {
      const r = await requireAuth();
      return r.response ? { response: r.response } : { userId: r.userId, isGuest: false };
    }
    case 'admin': {
      const r = await requireAdmin();
      return r.response ? { response: r.response } : { userId: r.userId, isGuest: false };
    }
    case 'guest-ok': {
      const r = await requireAuthOrGuest(request);
      return r.response
        ? { response: r.response }
        : { userId: r.userId, isGuest: r.isGuest };
    }
    case 'existing-guest': {
      const r = await requireAuthOrExistingGuest();
      return r.response ? { response: r.response } : { userId: r.userId, isGuest: r.isGuest };
    }
    case 'optional': {
      const r = await optionalAuth();
      return { userId: r.userId, isGuest: false };
    }
    case 'public':
      return { userId: null, isGuest: false };
  }
}

/** First hop from x-forwarded-for (Vercel sets this); 'unknown' if absent. */
function getClientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export function withGuards<C = unknown>(
  handler: GuardedHandler<C>,
  options: GuardOptions = {},
): (request: NextRequest, routeCtx?: C) => Promise<Response> {
  const { auth = 'required', rateLimit, errorLabel } = options;

  return async (request: NextRequest, routeCtx?: C): Promise<Response> => {
    // 1. Auth
    let userId: string | null = null;
    let isGuest = false;
    if (auth !== 'public') {
      const resolved = await resolveAuth(auth, request);
      if (resolved.response) return resolved.response;
      userId = resolved.userId ?? null;
      isGuest = resolved.isGuest ?? false;
    }

    // 2. Rate limit
    if (rateLimit) {
      const keyByIp = rateLimit.byIp || !userId;
      const result = await (keyByIp
        ? checkRateLimit(`ip:${getClientIp(request)}:${rateLimit.name}`, rateLimit.limit, rateLimit.windowMs)
        : checkUserRateLimit(userId!, rateLimit.name, rateLimit.limit, rateLimit.windowMs));
      if (!result.ok) {
        return NextResponse.json(
          { error: 'Too many requests' },
          { status: 429, headers: { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } },
        );
      }
    }

    // 3. Handler + error sanitisation (log full detail server-side, return generic)
    try {
      return await handler(request, { userId, isGuest }, routeCtx as C);
    } catch (error) {
      logger.error(`[withGuards] ${errorLabel ?? 'handler'} error`, {
        userId: userId ?? undefined,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}
