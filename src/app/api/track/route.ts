/**
 * Tracking API
 *
 * POST - Record page views and content interactions
 * Supports both authenticated users and anonymous sessions.
 */

import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-utils';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { updateDailyStats } from '@/lib/stats';
import { logExposure } from '@/lib/knowledge';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  readBoundedRequestJson,
  RequestBodyTooLargeError,
} from '@/lib/bounded-request-body';
import {
  generateFingerprint,
  getOrCreateAnonymousSession,
  recordAnonymousActivity,
  getAnonymousSessionActivity,
  shouldShowLoginNudge,
} from '@/lib/tracking/anonymous-session';

interface TrackingEvent {
  type: 'pageview' | 'interaction';
  path: string;
  // Page view specific
  duration?: number;
  scrollDepth?: number;
  // Interaction specific
  componentType?: string;
  componentId?: string;
  action?: string;
  metadata?: Record<string, unknown>;
  // Client-provided for anonymous tracking
  screenSize?: string;
  timezone?: string;
}

const MAX_TRACKING_BODY_BYTES = 16 * 1024;
const MAX_PAGE_DURATION_SECONDS = 24 * 60 * 60;

const trackingEventSchema = z.object({
  type: z.enum(['pageview', 'interaction']),
  path: z.string().trim().min(1).max(500),
  duration: z.number().int().min(0).max(MAX_PAGE_DURATION_SECONDS).optional(),
  scrollDepth: z.number().min(0).max(1).optional(),
  componentType: z.string().trim().max(100).optional(),
  componentId: z.string().trim().max(200).optional(),
  action: z.string().trim().max(100).optional(),
  metadata: z.record(z.unknown()).refine(
    (value) => JSON.stringify(value).length <= 4_096,
    'metadata is too large',
  ).optional(),
  screenSize: z.string().trim().max(50).optional(),
  timezone: z.string().trim().max(100).optional(),
});

function requestKey(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? 'unknown';
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_TRACKING_BODY_BYTES) {
    return NextResponse.json({ error: 'Request too large' }, { status: 413 });
  }

  const rate = await checkRateLimit(`track:${requestKey(request)}`, 240, 60_000);
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))) },
      },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await readBoundedRequestJson(request, MAX_TRACKING_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    }
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parseResult = trackingEventSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parseResult.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const event: TrackingEvent = parseResult.data;

  const auth = await requireAuth();

  // Handle anonymous users
  if (auth.response) {
    try {
      const userAgent = request.headers.get('user-agent') || 'unknown';
      const fingerprint = generateFingerprint(userAgent, event.screenSize, event.timezone);

      const { sessionId, isNew } = await getOrCreateAnonymousSession(fingerprint);

      const authFunnelEvent = event.componentType === 'AuthFunnel'
        && (event.action === 'signin_view' || event.action === 'auth_start')
        ? event.action
        : null;
      const eventType = authFunnelEvent ?? (event.action === 'signup_click'
        ? 'signup_click'
        : event.type === 'pageview'
          ? 'page_view'
          : 'interact');
      await prisma.feedEvent.create({
        data: {
          sessionFingerprint: sessionId,
          eventType,
          itemId: event.componentId ?? (event.type === 'pageview' ? event.path : null),
          itemType: event.componentType ?? (event.type === 'pageview' ? 'page' : null),
          action: event.action ?? null,
          dwellMs: event.duration != null ? Math.max(0, Math.round(event.duration * 1_000)) : null,
          metadata: event.metadata,
        },
      });

      // Record activity based on event type
      if (event.type === 'pageview') {
        await recordAnonymousActivity(sessionId, { pagesRead: 1 });
      }

      // Get activity to check if we should show login nudge
      const activity = await getAnonymousSessionActivity(sessionId);
      const nudge = activity ? shouldShowLoginNudge(activity) : { show: false };

      return NextResponse.json({
        success: true,
        anonymous: true,
        isNew,
        ...(nudge.show ? { nudge: nudge.reason } : {}),
      });
    } catch (error) {
      logger.error('Anonymous tracking error', { error: String(error) });
      return NextResponse.json({ error: 'Tracking failed' }, { status: 500 });
    }
  }

  const userId = auth.userId;

  try {
    const { type, path } = event;

    // Extract rotation and week from path
    const pathMatch = path.match(/\/([^/]+)\/week\/(\d+)/);
    const rotation = pathMatch?.[1] || null;
    const week = pathMatch?.[2] ? parseInt(pathMatch[2], 10) : null;

    if (type === 'pageview') {
      // Check for existing pageview to update (for duration/scroll updates)
      const recentView = await prisma.pageView.findFirst({
        where: {
          userId,
          path,
          viewedAt: {
            gte: new Date(Date.now() - 30 * 60 * 1000), // Last 30 mins
          },
        },
        orderBy: { viewedAt: 'desc' },
      });

      if (recentView && (event.duration || event.scrollDepth)) {
        // Update existing view
        await prisma.pageView.update({
          where: { id: recentView.id },
          data: {
            duration: event.duration || recentView.duration,
            scrollDepth: event.scrollDepth || recentView.scrollDepth,
          },
        });

        // Log page read exposure on final beacon (when we have duration/scroll data)
        if (event.duration || event.scrollDepth) {
          const exposureDuration = event.duration;
          const exposureScrollDepth = event.scrollDepth;

          after(async () => {
            try {
              await logExposure({
                userId,
                exposureType: 'page_read',
                sourceType: 'page',
                sourceId: path,
                metadata: {
                  durationSeconds: exposureDuration,
                  scrollDepth: exposureScrollDepth,
                },
              });
            } catch (err) {
              logger.error('Failed to log page exposure', { userId, path, error: String(err) });
            }
          });
        }
      } else if (!recentView) {
        // Create new page view
        await prisma.pageView.create({
          data: {
            userId,
            path,
            rotation,
            week,
            duration: event.duration,
            scrollDepth: event.scrollDepth,
          },
        });

        // Update daily stats
        await updateDailyStats(userId, { pagesViewed: 1 });
      }
    } else if (type === 'interaction') {
      // Image impression/reveal events → FeedEvent (consumed by audit:images).
      // Authenticated users get sessionFingerprint=null + userId set, which
      // is now allowed by the FeedEvent schema (2026-05-09 migration).
      if (event.componentType === 'Image' && (event.action === 'impression' || event.action === 'reveal')) {
        const eventType = event.action === 'impression' ? 'image_impression' : 'image_reveal';
        const imageMeta = event.metadata ?? {};
        after(async () => {
          try {
            await prisma.feedEvent.create({
              data: {
                userId,
                eventType,
                itemId: event.componentId ?? null,
                itemType: 'image',
                action: event.action,
                metadata: imageMeta,
              },
            });
          } catch (err) {
            logger.error('Failed to record image event', { userId, action: event.action, error: String(err) });
          }
        });
      }

      // Log exposure for expand/open actions on LearnMore/DeepDive
      // LearnMore uses 'expand', DeepDive uses 'open'
      if (
        ['expand', 'open'].includes(event.action || '') &&
        ['LearnMore', 'DeepDive'].includes(event.componentType || '')
      ) {
        const exposureComponentType = event.componentType;
        const exposureComponentId = event.componentId;
        after(async () => {
          try {
            await logExposure({
              userId,
              exposureType: 'content_expanded',
              sourceType: 'page',
              sourceId: path,
              metadata: {
                componentType: exposureComponentType,
                componentId: exposureComponentId,
              },
            });
          } catch (err) {
            logger.error('Failed to log expand exposure', { userId, path, error: String(err) });
          }
        });
      }

      // Log video watched exposure
      if (event.componentType === 'Video' && event.action === 'complete') {
        const exposureComponentId = event.componentId;
        after(async () => {
          try {
            await logExposure({
              userId,
              exposureType: 'video_watched',
              sourceType: 'page',
              sourceId: path,
              metadata: {
                componentId: exposureComponentId,
              },
            });
          } catch (err) {
            logger.error('Failed to log video exposure', { userId, path, error: String(err) });
          }
        });
      }
    }

    // Update last active
    await prisma.user.update({
      where: { id: userId },
      data: { lastActiveAt: new Date() },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Tracking error', { userId, error: String(error) });
    return NextResponse.json({ error: 'Tracking failed' }, { status: 500 });
  }
}
