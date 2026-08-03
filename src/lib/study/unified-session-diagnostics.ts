import { after } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { SessionContext } from './unified-session-types';

type SessionPath = 'starter' | 'cache-fresh' | 'cache-stale' | 'instant' | 'manifold' | 'fallback-error';

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
            cacheState: diagnostic.cacheState,
            isGuest: ctx.isGuest,
            hasFilters: ctx.hasFilters,
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
  details: { items?: number; durationMs?: number; error?: string },
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
        },
      },
    });
  } catch (err) {
    logger.error('Failed to log cache compute outcome', { error: String(err) });
  }
}
