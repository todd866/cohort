import { after } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { SessionContext } from './unified-session-types';

/**
 * Why `hasFilters` is true. A boolean alone cannot explain a cache skip:
 * a 2026-08-18 new-only review load logged hasFilters=true with no constituent,
 * so a warm CAH queue sat unused while live manifold builds ran 20–150s.
 */
export function sessionFilterReasons(ctx: SessionContext): string[] {
  const reasons: string[] = [];
  if (ctx.typeFilter) reasons.push(`type:${ctx.typeFilter}`);
  if (ctx.difficultyFilter) reasons.push(`difficulty:${ctx.difficultyFilter}`);
  if (ctx.topicsFilter) reasons.push(`topics:${ctx.topicsFilter}`);
  // hasFilters counts a cluster scope; without it here a topic-square build
  // logged hasFilters=true with no reason and read as an unfiltered baseline.
  if (ctx.clusterFilter) reasons.push(`cluster:${ctx.clusterFilter}`);
  if (ctx.modulesFilter) reasons.push(`modules:${ctx.modulesFilter}`);
  if (ctx.mode) reasons.push(`mode:${ctx.mode}`);
  if (ctx.reviewFilter) reasons.push(`filter:${ctx.reviewFilter}`);
  if (ctx.feedMode) reasons.push(`feedMode:${ctx.feedMode}`);
  if (ctx.crossSourceRotations && ctx.crossSourceRotations.length > 0) {
    reasons.push(`crossSource:${ctx.crossSourceRotations.join(',')}`);
  }
  return reasons;
}

type SessionPath = 'starter' | 'cache-fresh' | 'cache-stale' | 'instant' | 'manifold' | 'fallback-error' | 'public';

interface SessionDiagnostic {
  path: SessionPath;
  itemCount: number;
  totalMs: number;
  cacheState?: 'hit' | 'miss' | 'stale' | 'expired' | 'error' | 'skipped';
  exclusionCounts?: {
    recentCards?: number;
    recentQuestions?: number;
    clientCards?: number;
    clientQuestions?: number;
  };
  extra?: Record<string, unknown>;
}

/**
 * Log a session_served event to LearningEvent for queryable diagnostics.
 * Runs in after() so it doesn't block the response.
 *
 * `authMs` and `contentMapMs` are derived from the context here rather than
 * passed by each path, so no call site can forget them. They matter because
 * the cache path measures `totalMs` to the cache read, BEFORE filtering — a
 * 108s "cache hit" is therefore entirely pre-cache work, and without these two
 * phases the event stream cannot say which. The same breakdown already went
 * out as a `Server-Timing` header, which only a browser tab ever sees.
 */
export function logSessionDiagnostic(ctx: SessionContext, diagnostic: SessionDiagnostic) {
  after(async () => {
    try {
      await prisma.learningEvent.create({
        data: {
          userId: ctx.userId,
          eventType: 'session_served',
          sourceType: 'session',
          sourceId: ctx.sessionId,
          rotation: ctx.rotation,
          week: ctx.weekFilter,
          metadata: {
            path: diagnostic.path,
            itemCount: diagnostic.itemCount,
            totalMs: diagnostic.totalMs,
            authMs: +(ctx.tAuthEnd - ctx.t0).toFixed(1),
            contentMapMs: +ctx.tContentMapMs.toFixed(1),
            identityMs: +ctx.tIdentityMs.toFixed(1),
            cacheState: diagnostic.cacheState,
            isGuest: ctx.isGuest,
            hasFilters: ctx.hasFilters,
            ...(ctx.hasFilters ? { filterReasons: sessionFilterReasons(ctx) } : {}),
            batchSize: ctx.batchSize,
            ...diagnostic.exclusionCounts && { exclusionCounts: diagnostic.exclusionCounts },
            ...diagnostic.extra,
          },
        },
      });
    } catch (err) {
      logger.error('Failed to log session diagnostic', { error: String(err) });
    }
  });
}

/**
 * Log background cache computation outcome.
 * Called from after() callbacks that run computeAndHydrateSession.
 */
export async function logCacheComputeOutcome(
  userId: string,
  rotation: string,
  outcome: 'success' | 'empty' | 'timeout' | 'error' | 'stale',
  details: { items?: number; durationMs?: number; error?: string; source?: string },
) {
  try {
    await prisma.learningEvent.create({
      data: {
        userId,
        eventType: 'session_cache_compute',
        sourceType: 'session',
        sourceId: `cache:${rotation}:${Date.now()}`,
        rotation,
        metadata: {
          outcome,
          items: details.items ?? 0,
          durationMs: details.durationMs,
          error: details.error,
          // Trigger provenance. Without it, cron builds and request-path
          // builds are indistinguishable in the event stream — which is how
          // the 2026-08-20 "cron fires 1-4×/hour" misdiagnosis happened.
          source: details.source,
        },
      },
    });
  } catch (err) {
    logger.error('Failed to log cache compute outcome', { error: String(err) });
  }
}
