import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { requireAuth, requireAuthOrExistingGuest } from '@/lib/api-utils';
import { checkUserRateLimit } from '@/lib/rate-limit';
import {
  normalizeQuarantinedMessage,
  STRUCTURED_FLAG_REASONS,
  trustDecisionForReport,
} from '@/lib/flags/report-trust';
import { isTrustedReporterTier } from '@/lib/flags/trusted-reporters';
import { userIdCanAccessRequestedRotations } from '@/lib/personal-rotation-access';
import {
  filterDeliverableReinforcementCardRows,
  type ReinforcementCardBoundaryClient,
} from '@/lib/usmle/reinforcement-card-delivery';
import {
  findUniqueCard,
  ownerCardMaintenanceScope,
  scopedCardWhere,
} from '@/lib/cards/read-repository.server';
import { CHECKED_IN_OPEN_USMLE_RELEASE_IDS } from '@/lib/usmle/public-release-bundle';
import { USMLE_STEP1_OPEN_ROTATION } from '@/lib/usmle/raw-question-boundary';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
} as const;
const MAX_FLAG_REQUEST_BYTES = 16 * 1024;

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
  response.headers.append('Vary', 'Cookie');
  return response;
}

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...PRIVATE_HEADERS, ...headers },
  });
}

async function readBoundedJson(request: NextRequest): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null
    && Number.isFinite(Number(declaredLength))
    && Number(declaredLength) > MAX_FLAG_REQUEST_BYTES
  ) {
    throw new RangeError('Flag request is too large');
  }

  const reader = request.body?.getReader();
  if (!reader) return JSON.parse('');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_FLAG_REQUEST_BYTES) {
      await reader.cancel();
      throw new RangeError('Flag request is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

const safePath = z.string().trim().max(500).regex(/^\/[A-Za-z0-9?&=_%+.,:/-]*$/);
const safeSlug = z.string().trim().max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const safeTargetId = z.string().trim().min(1).max(500)
  .regex(/^(?:[A-Za-z0-9][A-Za-z0-9:_./-]*|\/[A-Za-z0-9?&=_%+.,:/-]*)$/);
const safeDeliveryId = z.string().trim().min(10).max(128).regex(/^[a-z0-9_-]+$/i);

const flagContextSchema = z.object({
  sessionItemCount: z.number().int().min(0).max(100_000).optional(),
  sessionStartPath: safePath.optional(),
  path: safePath.optional(),
  rotation: z.string().trim().max(50).regex(/^[a-z0-9][a-z0-9-]{0,49}$/).optional(),
  week: z.number().int().min(0).max(100).optional(),
  componentType: safeSlug.optional(),
  contentSnapshot: z.string().max(1000).optional(),
  // Render-environment harvest (src/lib/flag-diagnostics.ts) — captured at flag
  // time so rendering complaints ("context cut off") are diagnosable later.
  viewport: z.object({
    w: z.number().int().min(1).max(20_000),
    h: z.number().int().min(1).max(20_000),
    dpr: z.number().min(0.1).max(20),
  }).optional(),
  route: safePath.optional(),
  ua: z.string().max(400).optional(),
  overflowPx: z.number().int().min(0).max(10_000_000).optional(),
  bottomCoverPx: z.number().int().min(0).max(20_000).optional(),
}).optional();

const flagSchema = z.object({
  type: z.enum(['card', 'question', 'component', 'page']),
  id: safeTargetId,
  deliveryId: safeDeliveryId.optional(),
  reason: z.enum(STRUCTURED_FLAG_REASONS),
  message: z.string().max(1000).optional(),
  context: flagContextSchema,
  clientRequestId: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).superRefine((value, context) => {
  if (!value.deliveryId) return;
  if (value.type !== 'question') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryId'],
      message: 'deliveryId is valid only for question flags',
    });
  }
  if (value.id !== value.deliveryId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: 'public question flags must use the opaque delivery id',
    });
  }
});

const PUBLIC_STEP1_DECISION_PATHS = [
  'usmle-step1-baseline-v1',
  'usmle-step1-daily-v1',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A ServeDecision is a public capability only when it carries the server-
 * authored Step 1 delivery contract and its mode agrees with the persisted
 * decision path. This prevents an unrelated user-owned delivery from being
 * repurposed to cross the private content boundary.
 */
function isPublicStep1Delivery(
  payload: unknown,
  decisionPath: string | null,
): boolean {
  if (!isRecord(payload)) return false;
  const isLegacy = payload.contract === 'usmle-step1-delivery-v2';
  if (!isLegacy && payload.contract !== 'usmle-step1-delivery-v3') return false;
  if (
    !isLegacy
    && payload.surface !== 'usmle-step1'
    && payload.surface !== 'cohort'
  ) return false;
  if (payload.mode !== 'baseline' && payload.mode !== 'daily') return false;
  if (
    typeof payload.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(payload.contentHash)
    || typeof payload.servingFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(payload.servingFingerprint)
  ) return false;
  return decisionPath === (payload.mode === 'baseline'
    ? 'usmle-step1-baseline-v1'
    : 'usmle-step1-daily-v1');
}

/**
 * POST /api/content/flag
 * Record a flag on content - creates a proper issue ticket with audit trail
 *
 * Body:
 * - type: 'card' | 'question' | 'component' | 'page'
 * - id: string
 * - reason: 'Context' | 'Formatting' | 'Needs Image' | 'Giveaway' | 'Rewrite' | 'Length Bias' | 'Acronym' | 'Too Long' | 'Other'
 * - message?: string (for "Other" reason)
 * - context?: {
 *     sessionItemCount?: number,
 *     sessionStartPath?: string,
 *     path?: string,
 *     rotation?: string,
 *     week?: number,
 *     componentType?: string,
 *     contentSnapshot?: string
 *   }
 */

// Map user-facing reasons to issue types
const REASON_TO_ISSUE_TYPE: Record<string, string> = {
  // Current reasons (reordered by usage 2026-02)
  'Context': 'context',
  'Formatting': 'formatting',
  'Needs Image': 'needs-image',
  'Giveaway': 'too-easy',
  'Rewrite': 'rewrite',
  'Length Bias': 'length-bias',
  'Acronym': 'tla',
  'Too Long': 'too-long',
  'Other': 'other',
  // Legacy reasons (for backwards compat)
  'Too Easy': 'too-easy',
  'Confusing': 'rewrite',
  'TLA': 'tla',
  'Irrelevant': 'other',
  'Incorrect': 'incorrect',
};

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof RangeError) {
      return json({ error: 'Flag request is too large' }, 413);
    }
    // Preserve the private endpoint's auth-first behavior when there is no
    // parseable delivery capability to select the existing-guest path.
    const auth = await requireAuth();
    if (auth.response) return privateResponse(auth.response);
    return json({ error: 'Invalid request' }, 400);
  }

  const hasDeliveryIntent = isRecord(rawBody)
    && Object.prototype.hasOwnProperty.call(rawBody, 'deliveryId');
  let userId: string;
  let isAdmin = false;
  let reporterImageTier: string | null = null;
  let publicReporterAccountType: 'authenticated' | 'guest' | undefined;
  if (hasDeliveryIntent) {
    // Write routes may reuse an existing guest, but must never create one.
    const auth = await requireAuthOrExistingGuest();
    if (auth.response) return privateResponse(auth.response);
    userId = auth.userId;
    publicReporterAccountType = auth.isGuest ? 'guest' : 'authenticated';
    if (!auth.isGuest) {
      // The guest-aware helper intentionally exposes no trust role. Re-read the
      // authenticated session only for signed-in callers so admin-authored
      // public flags keep the same trust behavior as private flags. If identity
      // changed between reads, fail closed instead of attributing across users.
      const signedInAuth = await requireAuth();
      if (signedInAuth.response) return privateResponse(signedInAuth.response);
      if (signedInAuth.userId !== userId) {
        return json({ error: 'Authentication required' }, 401);
      }
      isAdmin = signedInAuth.isAdmin === true;
      reporterImageTier = signedInAuth.imageTier ?? null;
    }
  } else {
    // Existing private card/question/component/page behavior remains signed-in
    // only, including the reporter-trust decision for admins.
    const auth = await requireAuth();
    if (auth.response) return privateResponse(auth.response);
    userId = auth.userId;
    isAdmin = auth.isAdmin === true;
    reporterImageTier = auth.imageTier ?? null;
  }

  const rateLimit = await checkUserRateLimit(userId, 'content-flag', 30, 60_000);
  if (!rateLimit.ok) {
    return json(
      { error: 'Too many requests' },
      429,
      { 'Retry-After': String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000))) },
    );
  }

  try {
    const parseResult = flagSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return json(
        { error: 'Invalid request', details: parseResult.error.flatten().fieldErrors },
        400,
      );
    }

    const { type, id, deliveryId, reason, message, context, clientRequestId } = parseResult.data;
    const reasonLabel = reason;
    const contextData = context ?? {};

    // Resolve only routing metadata before entering the write transaction.
    // Missing and unentitled personal content deliberately share one response,
    // and neither path reads canonical text or creates learner state.
    let authorizedRotation: string | undefined;
    let targetId = id;
    if (type === 'card') {
      const cardScope = ownerCardMaintenanceScope('content-quality', userId);
      const target = await findUniqueCard(cardScope, {
        where: { id },
        select: { rotation: true },
      });
      if (
        !target ||
        !await userIdCanAccessRequestedRotations(userId, [target.rotation])
      ) {
        return json({ error: 'Content not found' }, 404);
      }
      authorizedRotation = target.rotation;
    } else if (type === 'question') {
      if (deliveryId) {
        const delivery = await prisma.serveDecision.findFirst({
          where: {
            id: deliveryId,
            userId,
            itemType: 'question',
            deliveryPath: 'live',
            decisionPath: { in: [...PUBLIC_STEP1_DECISION_PATHS] },
          },
          select: {
            itemId: true,
            decisionPath: true,
            payload: true,
          },
        });
        if (
          !delivery
          || !isPublicStep1Delivery(delivery.payload, delivery.decisionPath)
          || !CHECKED_IN_OPEN_USMLE_RELEASE_IDS.has(delivery.itemId)
        ) {
          return json({ error: 'Content not found' }, 404);
        }
        targetId = delivery.itemId;
        const target = await prisma.question.findUnique({
          where: { id: targetId },
          select: { rotation: true },
        });
        if (!target || target.rotation !== USMLE_STEP1_OPEN_ROTATION) {
          return json({ error: 'Content not found' }, 404);
        }
        authorizedRotation = target.rotation;
      } else {
        const target = await prisma.question.findUnique({
          where: { id },
          select: { rotation: true },
        });
        if (
          !target
          || !await userIdCanAccessRequestedRotations(userId, [target.rotation])
        ) {
          return json({ error: 'Content not found' }, 404);
        }
        authorizedRotation = target.rotation;
      }
    }

    const issueType = REASON_TO_ISSUE_TYPE[reasonLabel] ?? 'other';
    const path = typeof contextData.path === 'string'
      ? contextData.path
      : (typeof contextData.route === 'string' ? contextData.route : undefined);
    const rotation = typeof contextData.rotation === 'string' ? contextData.rotation : undefined;

    // Only bounded numeric diagnostics and a validated path cross into agent-
    // visible metadata. The raw UA and client-provided content snapshot stay in
    // the admin-only quarantine fields below.
    const render =
      contextData.viewport || contextData.overflowPx != null || contextData.route
        ? {
            viewport: contextData.viewport,
            route: contextData.route,
            overflowPx: contextData.overflowPx,
            bottomCoverPx: contextData.bottomCoverPx,
          }
        : undefined;
    const quarantinedMessage = normalizeQuarantinedMessage(message);
    // Trust is a property of WHO reported, not of whether the note has prose.
    // An admin's note — and an allowlisted classmate's — is auto-approved into
    // the same lifecycle a human reviewer would use; everyone else stays
    // quarantined. The injection scan still runs either way.
    //
    // Read from the session that already authenticated this write — no second
    // round-trip, and an absent tier (guest, or a test double) fails closed.
    const trust = trustDecisionForReport(quarantinedMessage, {
      isAdmin,
      isTrustedReporter: isTrustedReporterTier(reporterImageTier),
    });
    const quarantinedContext: Record<string, string> = {};
    if (contextData.contentSnapshot) quarantinedContext.clientContentSnapshot = contextData.contentSnapshot;
    if (contextData.ua) quarantinedContext.userAgent = contextData.ua;
    if (contextData.sessionStartPath) quarantinedContext.sessionStartPath = contextData.sessionStartPath;

    // All flag writes are atomic: issue + user state
    // Each flag creates its own issue — no aggregation, so every flag is visible in triage
    const issue = await prisma.$transaction(async (tx) => {
      // Never trust a client-supplied snapshot as resolution evidence. Capture
      // the current canonical content inside the same transaction instead. Pin
      // the read to the rotation authorized above so a concurrent move into a
      // personal deck fails closed before progress or issue writes.
      let contentSnapshot: string | undefined;
      if (type === 'card') {
        const deliverable = await filterDeliverableReinforcementCardRows([{ id }], {
          client: tx as unknown as ReinforcementCardBoundaryClient,
          logContext: { transport: 'content-flag-snapshot' },
        });
        if (deliverable.length === 0) return null;
        const card = await tx.card.findUnique({
          where: scopedCardWhere(
            ownerCardMaintenanceScope('content-quality', userId),
            { id, rotation: authorizedRotation },
          ) as Prisma.CardWhereUniqueInput,
          select: { front: true },
        });
        if (!card) return null;
        contentSnapshot = card.front.slice(0, 200);
      } else if (type === 'question') {
        const question = await tx.question.findUnique({
          where: { id: targetId, rotation: authorizedRotation },
          select: { stem: true },
        });
        if (!question) return null;
        contentSnapshot = question.stem.slice(0, 200);
      }

      // Idempotency: a queue replay must not create a second issue.
      if (clientRequestId) {
        const existing = await tx.contentIssue.findFirst({ where: { clientRequestId } });
        if (existing) return existing;
      }

      let txIssue;
      try {
        txIssue = await tx.contentIssue.create({
          data: {
            targetType: type,
            targetId,
            issueType,
            status: 'open',
            priority: 'normal',
            reportCount: 1,
            contentSnapshot,
            path,
            rotation,
            clientRequestId: clientRequestId ?? null,
            reportTrustState: trust.state,
            ...(trust.approvedSummary
              ? {
                  approvedSummary: trust.approvedSummary,
                  trustReviewedBy: trust.trustReviewedBy,
                  trustReviewedAt: trust.trustReviewedAt,
                }
              : {}),
            quarantinedMessage,
            ...(Object.keys(quarantinedContext).length > 0 ? { quarantinedContext } : {}),
            metadata: {
              reporterType: 'user',
              userId,
              reason: reasonLabel,
              hasQuarantinedMessage: Boolean(quarantinedMessage),
              ...(deliveryId
                ? { deliveryId, reporterAccountType: publicReporterAccountType }
                : {}),
              ...(render ? { render } : {}),
            },
          },
        });
      } catch (e) {
        if (clientRequestId && (e as { code?: string }).code === 'P2002') {
          const existing = await tx.contentIssue.findFirst({ where: { clientRequestId } });
          if (existing) return existing;
        }
        throw e;
      }

      // Update the user's local state for UI feedback
      if (type === 'card') {
        const flagContext = {
          issueId: txIssue.id,
          timestamp: new Date().toISOString(),
          hasQuarantinedMessage: Boolean(quarantinedMessage),
          ...(render ? { render } : {}),
        };

        await tx.cardProgress.upsert({
          where: { cardId_userId: { cardId: id, userId } },
          update: {
            flagged: true,
            flaggedAt: new Date(),
            flagReason: reasonLabel,
            flagContext,
          },
          create: {
            cardId: id,
            userId,
            flagged: true,
            flaggedAt: new Date(),
            flagReason: reasonLabel,
            flagContext,
          },
        });
      } else if (type === 'question') {
        await tx.questionResponse.updateMany({
          where: { userId, questionId: targetId },
          data: { flagged: true },
        });
      }

      return txIssue;
    });

    if (!issue) {
      return json({ error: 'Content not found' }, 404);
    }

    // Log only the client-visible identifier. For public questions this is the
    // opaque delivery capability, never the canonical question id.
    logger.info('Content flag recorded', {
      userId,
      type,
      id: deliveryId ?? id,
      reason: reasonLabel,
      issueId: issue.id,
      reportCount: issue.reportCount,
    });

    return json({
      success: true,
      issueId: issue.id,
      reportCount: issue.reportCount,
    });
  } catch (error) {
    logger.error('Error recording flag', { userId, error: String(error) });
    return json({ error: 'Failed to record flag' }, 500);
  }
}
