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
import {
  FOLLOW_UP_DELIVERY_SCHEMA,
  followUpItemFingerprint,
  currentSource,
  ownsOriginalMiss,
} from '@/lib/practice-exam/follow-up.server';
import {
  listPublicPracticePapers,
  loadPublicPracticePaper,
  PUBLIC_PRACTICE_ATTEMPT_SCHEMA,
} from '@/lib/practice-exam/public-paper';
import { practiceReviewPaperVersion } from '@/lib/study/practice-review-focus.server';

import { isSameOriginImageRequest, FLAG_IMAGE_MAX_BYTES } from '@/lib/flags/image-contract';

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
  const limit = request.headers.get('x-flag-image-upload') === '1' ? Math.ceil(FLAG_IMAGE_MAX_BYTES * 4 / 3) + 16_384 : MAX_FLAG_REQUEST_BYTES;
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null
    && Number.isFinite(Number(declaredLength))
    && Number(declaredLength) > limit
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
    if (totalBytes > limit) {
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
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (totalBytes > MAX_FLAG_REQUEST_BYTES && (!isRecord(parsed) || !parsed.imageUpload)) throw new RangeError('Flag request is too large');
  return parsed;
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
  attachmentId: z.string().regex(/^flag-image-[a-f0-9]{64}$/).optional(),
  imageUpload: z.object({ uploadId: z.string().uuid(), base64: z.string().max(Math.ceil(FLAG_IMAGE_MAX_BYTES * 4 / 3) + 4) }).strict().optional(),
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
  if (request.headers.get('x-flag-image-upload') === '1') {
    // Authorize and throttle before buffering the larger image body. This does
    // not mint a guest or replace target authorization below.
    if (!isSameOriginImageRequest(request)) return json({ error: 'Same-origin request required' }, 403);
    const uploadAuth = await requireAuthOrExistingGuest();
    if (uploadAuth.response) return privateResponse(uploadAuth.response);
    const uploadLimit = await checkUserRateLimit(uploadAuth.userId, 'flag-image-upload', 10, 60_000);
    if (!uploadLimit.ok) return json({ error: 'Try again shortly' }, 429);
  }
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

    const { type, id, deliveryId, reason, message, context, clientRequestId, attachmentId, imageUpload } = parseResult.data;
    if ((attachmentId || imageUpload) && !isSameOriginImageRequest(request)) return json({ error: 'Same-origin request required' }, 403);
    if (attachmentId && imageUpload) return json({ error: 'Invalid image request' }, 400);
    if (attachmentId && !clientRequestId) return json({ error: 'Request identifier required' }, 400);
    const reasonLabel = reason;
    const contextData = context ?? {};

    // Resolve only routing metadata before entering the write transaction.
    // Missing and unentitled personal content deliberately share one response,
    // and neither path reads canonical text or creates learner state.
    let authorizedRotation: string | undefined;
    let targetId = id;
    let targetType: 'card' | 'question' | 'component' | 'page' = type;
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
            itemType: { in: ['question', 'practice-exam-retest'] },
            deliveryPath: 'live',
          },
          select: {
            itemId: true,
            itemType: true,
            decisionPath: true,
            payload: true,
          },
        });
        if (!delivery) {
          return json({ error: 'Content not found' }, 404);
        }
        if (delivery.itemType === 'practice-exam-retest') {
          const payload = isRecord(delivery.payload) ? delivery.payload : null;
          if (!payload || payload.schema !== FOLLOW_UP_DELIVERY_SCHEMA
            || typeof payload.entryKey !== 'string' || typeof payload.revision !== 'number'
            || typeof payload.itemFingerprint !== 'string' || typeof payload.paperVersion !== 'string'
            || typeof payload.sourceAttemptId !== 'string') {
            return json({ error: 'Content not found' }, 404);
          }
          const keyParts = payload.entryKey.split(':');
          const [paperId, paperVersion, itemId] = keyParts;
          const paper = keyParts.length === 3 ? loadPublicPracticePaper(paperId) : null;
          const listing = paper ? listPublicPracticePapers(paper.rotation).find(candidate => candidate.id === paper.id) : null;
          const item = paper ? paper.items.find(candidate => candidate.id === itemId) : null;
          const attempt = paper ? await prisma.examPaperSession.findFirst({
            where: { id: payload.sourceAttemptId, userId, rotation: paper.rotation, submittedAt: { not: null } },
            select: { paper: true, answers: true, submittedAt: true },
          }) : null;
          const attemptPaper = isRecord(attempt?.paper) ? attempt.paper : null;
          const sourceIndex = attemptPaper && Array.isArray(attemptPaper.itemIds) ? attemptPaper.itemIds.indexOf(itemId) : -1;
          const entry = paper && listing && item && attempt?.submittedAt && sourceIndex >= 0 ? {
            key: payload.entryKey, rotation: paper.rotation, paperId: paper.id, paperVersion,
            itemId, itemFingerprint: payload.itemFingerprint, attemptId: payload.sourceAttemptId,
            questionNumber: sourceIndex + 1, paperTitle: listing.title,
            paperPath: `/practice-exam/${paper.rotation}/${listing.slug}`,
            sourceSubmittedAt: attempt.submittedAt.toISOString(), phase: 'retest' as const,
            revision: payload.revision, updatedAt: attempt.submittedAt.toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            availableAfter: attempt.submittedAt.toISOString(),
            ...(attemptPaper?.paperVersion == null ? { sourceCompatibility: 'legacy-stable-question-v1' as const } : {}),
          } : null;
          const source = entry ? currentSource(entry) : null;
          if (!paper || !entry || !source || source.item !== item || paperVersion !== practiceReviewPaperVersion(paper)
            || followUpItemFingerprint(item) !== payload.itemFingerprint
            || !attemptPaper || attemptPaper.schema !== PUBLIC_PRACTICE_ATTEMPT_SCHEMA
            || !await ownsOriginalMiss(prisma, userId, entry, item)) {
            return json({ error: 'Content not found' }, 404);
          }
          // Keep the client-facing capability question-shaped, then resolve it
          // to the canonical published exam component only after owner/source checks.
          targetId = `practice-exam:${entry.paperId}:${entry.itemId}`;
          authorizedRotation = entry.rotation;
          targetType = 'component';
        } else {
          if (!isPublicStep1Delivery(delivery.payload, delivery.decisionPath)
            || !CHECKED_IN_OPEN_USMLE_RELEASE_IDS.has(delivery.itemId)) {
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
        }
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

    // Reuse the exact card/public-delivery authorization above before storing
    // any bytes. Preparation creates no issue and returns no canonical IDs.
    if (imageUpload) {
      try {
        const { prepareFlagImage } = await import('@/lib/flags/image.server');
        const imageId = await prepareFlagImage(userId, targetType, targetId, imageUpload.uploadId, imageUpload.base64);
        return json({ attachmentId: imageId });
      } catch {
        return json({ error: 'Image could not be uploaded. Use a PNG, JPEG or WebP under 2 MB and try again.' }, 422);
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
      if (attachmentId) {
        const owners = await tx.$queryRawUnsafe<Array<{ privacyDeletionRequestedAt: Date | null }>>(
          'SELECT "privacyDeletionRequestedAt" FROM "User" WHERE "id" = $1 FOR UPDATE', userId,
        );
        if (owners.length !== 1 || owners[0].privacyDeletionRequestedAt) return null;
      }
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
      } else if (targetType === 'question') {
        const question = await tx.question.findUnique({
          where: { id: targetId, rotation: authorizedRotation },
          select: { stem: true },
        });
        if (!question) return null;
        contentSnapshot = question.stem.slice(0, 200);
      }

      let attachment: Awaited<ReturnType<typeof tx.userDocument.findUnique>> | null = null;
      if (attachmentId) {
        attachment = await tx.userDocument.findUnique({ where: { id: attachmentId } });
        const meta = attachment?.metadata as Record<string, unknown> | null;
        if (attachment && (attachment.userId !== userId || attachment.purpose !== 'flag-image'
          || meta?.targetType !== targetType || meta?.targetId !== targetId)) return null;
        // A delayed outbox may outlive its image draft. Preserve the authorized
        // text report, explicitly recording the missing evidence for triage.
        if (attachment && (attachment.status !== 'quarantined'
          || (!attachment.flagIssueId && (!attachment.deleteAfter || attachment.deleteAfter <= new Date())))) attachment = null;
      }

      // Idempotency: a queue replay must not create a second issue.
      if (clientRequestId) {
        const existing = await tx.contentIssue.findFirst({ where: { clientRequestId } });
        if (existing) {
          const reporter = existing.metadata as Record<string, unknown> | null;
          if (reporter?.userId !== userId || existing.targetId !== targetId || existing.targetType !== targetType) return null;
          if (attachment && attachment.flagIssueId !== existing.id) return null;
          return existing;
        }
      }

      if (attachment?.flagIssueId) attachment = null;
      let txIssue;
      try {
        txIssue = await tx.contentIssue.create({
          data: {
            targetType,
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
              ...(attachmentId && !attachment ? { attachmentUnavailable: true } : {}),
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
        // A concurrent unique-key winner is retried through the durable outbox;
        // the next transaction verifies its reporter, target and attachment.
        throw e;
      }

      // Update the user's local state for UI feedback
      if (attachment) {
        const linked = await tx.userDocument.updateMany({
          where: { id: attachment.id, userId, flagIssueId: null, status: 'quarantined', deleteAfter: { gt: new Date() } },
          data: { flagIssueId: txIssue.id },
        });
        if (linked.count !== 1) throw new Error('Attachment state changed');
      }

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
      } else if (targetType === 'question') {
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
      type: targetType,
      id: deliveryId ?? id,
      reason: reasonLabel,
      issueId: issue.id,
      reportCount: issue.reportCount,
    });

    return json({
      success: true,
      issueId: issue.id,
      reportCount: issue.reportCount,
    }, 200, (issue.metadata as Record<string, unknown> | null)?.attachmentUnavailable === true ? { 'X-Flag-Attachment-Unavailable': '1' } : {});
  } catch (error) {
    logger.error('Error recording flag', { userId, error: String(error) });
    return json({ error: 'Failed to record flag' }, 500);
  }
}
