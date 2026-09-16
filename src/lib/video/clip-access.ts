/**
 * Delivery gate for operative video clips.
 *
 * Fail-closed in three independent ways, because a clip is copyrighted
 * operative footage cut from someone else's video and the cost of leaking one
 * is not symmetric with the cost of withholding it:
 *
 *  1. **Rights.** Only a source explicitly marked `cleared` serves. A source row
 *     that discovery created and nobody has reviewed is `restricted`, and a
 *     takedown is a single flag flip on one row rather than a hunt through R2.
 *  2. **Tier.** Copyright-tier users only, matching the image-as-prompt lane.
 *  3. **Soft delete.** A retired clip stops serving without losing the card's
 *     review history.
 *
 * The signed URL is minted only after all three pass. That ordering is the
 * point: a signed R2 URL is a 15-minute bearer token, so minting one for a clip
 * we are about to withhold would defeat the gate it just failed.
 */

import { prisma } from '@/lib/prisma';
import type { ClipPromptData } from '@/components/review/clip-role';
import { getSignedVideoUrl } from '@/lib/video-storage';

export type ClipDenialReason = 'rights' | 'tier' | 'deleted';

export interface ClipServeDecision {
  allowed: boolean;
  reason?: ClipDenialReason;
}

export function canServeClip(input: {
  rightsStatus: string | null | undefined;
  deletedAt: Date | null | undefined;
  isCopyrightTier: boolean;
}): ClipServeDecision {
  if (input.rightsStatus !== 'cleared') return { allowed: false, reason: 'rights' };
  if (input.deletedAt) return { allowed: false, reason: 'deleted' };
  if (!input.isCopyrightTier) return { allowed: false, reason: 'tier' };
  return { allowed: true };
}

export interface ResolvedClip {
  id: string;
  url: string;
  posterUrl: string | null;
  startSecs: number;
  endSecs: number;
  clipKind: string;
  audioStripped: boolean;
  /** Upstream watch URL and title. Shown post-reveal as attribution and as the
   *  route back to the full operation for anyone who wants the context. */
  sourceUrl: string;
  sourceTitle: string;
}

export async function resolveClipForDelivery(
  clipId: string,
  opts: { isCopyrightTier: boolean },
): Promise<ResolvedClip | null> {
  const clip = await prisma.videoClip.findUnique({
    where: { id: clipId },
    select: {
      id: true,
      r2Key: true,
      posterR2Key: true,
      startSecs: true,
      endSecs: true,
      clipKind: true,
      audioStripped: true,
      deletedAt: true,
      source: { select: { rightsStatus: true, url: true, title: true } },
    },
  });
  if (!clip) return null;

  const decision = canServeClip({
    rightsStatus: clip.source?.rightsStatus,
    deletedAt: clip.deletedAt,
    isCopyrightTier: opts.isCopyrightTier,
  });
  if (!decision.allowed) return null;

  const [url, posterUrl] = await Promise.all([
    getSignedVideoUrl(clip.r2Key),
    clip.posterR2Key ? getSignedVideoUrl(clip.posterR2Key) : Promise.resolve(null),
  ]);

  return {
    id: clip.id,
    url,
    posterUrl,
    startSecs: clip.startSecs,
    endSecs: clip.endSecs,
    clipKind: clip.clipKind,
    audioStripped: clip.audioStripped,
    sourceUrl: clip.source.url,
    sourceTitle: clip.source.title,
  };
}

/**
 * Resolve every clip a session needs in one query.
 *
 * The per-item form above is right for a single delivery request; calling it
 * once per card in a 60-item session would be sixty round trips on the path a
 * learner is waiting on. Signing is local HMAC and costs nothing, but it only
 * happens for clips that survive the gate — the same ordering rule as the
 * single-clip path, for the same reason.
 *
 * Clips that fail the gate are simply absent from the map. Callers must treat a
 * missing entry as "drop this card", never as "serve it without its stem".
 */
export async function resolveClipsForSession(
  clipIds: Iterable<string>,
  opts: { isCopyrightTier: boolean },
): Promise<Map<string, ClipPromptData>> {
  const ids = Array.from(new Set([...clipIds].filter(Boolean)));
  const out = new Map<string, ClipPromptData>();
  if (ids.length === 0) return out;

  // A standard-tier user can have no servable clip at all, so skip the query
  // rather than fetch rows we are certain to discard.
  if (!opts.isCopyrightTier) return out;

  const clips = await prisma.videoClip.findMany({
    where: { id: { in: ids }, deletedAt: null, source: { rightsStatus: 'cleared' } },
    select: {
      id: true,
      r2Key: true,
      posterR2Key: true,
      startSecs: true,
      endSecs: true,
      audioStripped: true,
      deletedAt: true,
      source: { select: { rightsStatus: true, url: true, title: true } },
    },
  });

  await Promise.all(clips.map(async (clip) => {
    // The where-clause above already filtered, but the decision function is the
    // single place the rule lives; re-asking it here means a future change to
    // the rule cannot be half-applied.
    if (!canServeClip({
      rightsStatus: clip.source?.rightsStatus,
      deletedAt: clip.deletedAt,
      isCopyrightTier: opts.isCopyrightTier,
    }).allowed) return;

    const [url, posterUrl] = await Promise.all([
      getSignedVideoUrl(clip.r2Key),
      clip.posterR2Key ? getSignedVideoUrl(clip.posterR2Key) : Promise.resolve(null),
    ]);
    out.set(clip.id, {
      id: clip.id,
      url,
      posterUrl,
      audioStripped: clip.audioStripped,
      sourceUrl: clip.source.url,
      sourceTitle: clip.source.title,
      startSecs: clip.startSecs,
      endSecs: clip.endSecs,
    });
  }));

  return out;
}
