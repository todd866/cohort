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
 *  2. **Tier.** Copyright tier, or an exact individually reviewed public asset.
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
import { logger } from '@/lib/logger';
import { isPublicClipId, reviewedPublicClip, type PublicClipCandidate } from './public-clips';
import { isSensitiveClipSlug } from './sensitive-clips';

export type ClipDenialReason = 'rights' | 'tier' | 'deleted';

export interface ClipServeDecision {
  allowed: boolean;
  reason?: ClipDenialReason;
}

export function canServeClip(input: {
  rightsStatus: string | null | undefined;
  deletedAt: Date | null | undefined;
  isCopyrightTier: boolean;
  clip?: PublicClipCandidate;
}): ClipServeDecision {
  if (input.rightsStatus !== 'cleared') return { allowed: false, reason: 'rights' };
  if (input.deletedAt) return { allowed: false, reason: 'deleted' };
  if (!input.isCopyrightTier && (!input.clip || !reviewedPublicClip(input.clip))) {
    return { allowed: false, reason: 'tier' };
  }
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
  sourceAuthor: string | null;
  sourceLicence: string | null;
  sourceLicenceUrl: string | null;
  publicReuse?: ClipPromptData['publicReuse'];
}

function sourceAttribution(clip: PublicClipCandidate & {
  source: PublicClipCandidate['source'] & { title: string; channelName: string | null };
}) {
  const reviewed = reviewedPublicClip(clip);
  return {
    sourceUrl: reviewed?.sourceUrl ?? clip.source.url,
    sourceTitle: reviewed?.title ?? clip.source.title,
    sourceAuthor: reviewed?.author ?? clip.source.channelName,
    sourceLicence: reviewed?.licence ?? clip.source.licence ?? null,
    sourceLicenceUrl: reviewed?.licenceUrl ?? recognisedCreativeCommonsLicence(clip.source.licence),
    ...(reviewed ? { publicReuse: { copyright: reviewed.copyright, changes: reviewed.changes } } : {}),
  };
}

/**
 * Return a canonical URL only for licence strings we deliberately understand.
 * Discovery values are verbatim and often absent; unknown values must never
 * become a guessed licence link in learner-facing attribution.
 */
export function recognisedCreativeCommonsLicence(licence: string | null | undefined): string | null {
  const value = licence?.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!value) return null;
  const match = value.match(/^(?:cc\s*)?by(?:-nc)?(?:-sa)?\s*(?:v?)([234])(?:\.0)?$/)
    ?? value.match(/^creative commons attribution(?:-noncommercial)?(?:-sharealike)?\s*([234])(?:\.0)?(?: international)?$/);
  if (!match) return null;
  const version = match[1];
  const suffix = value.includes('noncommercial') || value.includes('by-nc') ? '-nc' : '';
  const shareAlike = value.includes('sharealike') || value.includes('-sa') ? '-sa' : '';
  return `https://creativecommons.org/licenses/by${suffix}${shareAlike}/${version}.0/`;
}

export async function resolveClipForDelivery(
  clipId: string,
  opts: { isCopyrightTier: boolean },
): Promise<ResolvedClip | null> {
  const clip = await prisma.videoClip.findUnique({
    where: { id: clipId },
    select: {
      id: true,
      sourceId: true,
      r2Key: true,
      posterR2Key: true,
      startSecs: true,
      endSecs: true,
      clipKind: true,
      audioStripped: true,
      deletedAt: true,
      source: { select: { rightsStatus: true, url: true, title: true, channelName: true, licence: true } },
    },
  });
  if (!clip) return null;

  const decision = canServeClip({
    rightsStatus: clip.source?.rightsStatus,
    deletedAt: clip.deletedAt,
    isCopyrightTier: opts.isCopyrightTier,
    clip,
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
    ...sourceAttribution(clip),
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
  const ids = Array.from(new Set([...clipIds].filter(id => id && (opts.isCopyrightTier || isPublicClipId(id)))));
  const out = new Map<string, ClipPromptData>();
  if (ids.length === 0) return out;

  const clips = await prisma.videoClip.findMany({
    where: { id: { in: ids }, deletedAt: null, source: { rightsStatus: 'cleared' } },
    select: {
      id: true,
      slug: true,
      sourceId: true,
      r2Key: true,
      posterR2Key: true,
      startSecs: true,
      endSecs: true,
      audioStripped: true,
      deletedAt: true,
      source: { select: { rightsStatus: true, url: true, title: true, channelName: true, licence: true } },
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
      clip,
    }).allowed) return;

    try {
      const [url, posterUrl] = await Promise.all([
        getSignedVideoUrl(clip.r2Key),
        clip.posterR2Key ? getSignedVideoUrl(clip.posterR2Key) : Promise.resolve(null),
      ]);
      out.set(clip.id, {
        id: clip.id,
        url,
        posterUrl,
        audioStripped: clip.audioStripped,
        ...sourceAttribution(clip),
        startSecs: clip.startSecs,
        endSecs: clip.endSecs,
        ...(isSensitiveClipSlug(clip.slug) ? { sensitive: true } : {}),
      });
    } catch {
      // One malformed or unavailable object must not erase healthy clips in
      // the same session. Keep the failed clip absent so prompt callers still
      // fail closed; never log a signed URL or storage key.
      logger.warn('Clip signing failed; withholding clip', { clipId: clip.id });
    }
  }));

  return out;
}
