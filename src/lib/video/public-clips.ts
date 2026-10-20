import { PUBLIC_CLIP_RIGHTS } from './public-clip-catalog';

/** An asset-specific public reuse decision, never a licence-string shortcut. */
export interface PublicClipRights {
  id: string;
  sourceId: string;
  sourceUrl: string;
  r2Key: string;
  posterR2Key: string;
  startSecs: number;
  endSecs: number;
  audioStripped: true;
  licence: string;
  licenceUrl: string;
  title: string;
  author: string;
  copyright: string;
  changes: string;
  sha256: string;
  posterSha256: string;
}

export interface PublicClipCandidate {
  id: string;
  sourceId: string;
  r2Key: string;
  posterR2Key: string | null;
  startSecs: number;
  endSecs: number;
  audioStripped: boolean;
  source: { url: string; licence?: string | null };
}

const byId = new Map(PUBLIC_CLIP_RIGHTS.map(entry => [entry.id, entry]));

/** Cheap prefilter only. The full source/asset match must precede signing. */
export function isPublicClipId(id: string): boolean {
  return byId.has(id);
}

export function reviewedPublicClip(clip: PublicClipCandidate): PublicClipRights | undefined {
  const entry = byId.get(clip.id);
  if (!entry || clip.sourceId !== entry.sourceId || clip.r2Key !== entry.r2Key
    || clip.posterR2Key !== entry.posterR2Key || clip.startSecs !== entry.startSecs
    || clip.endSecs !== entry.endSecs || clip.audioStripped !== entry.audioStripped
    || clip.source.url !== entry.sourceUrl || clip.source.licence !== entry.licence) return undefined;
  return entry;
}

/** Pool filtering and final signing share the same exact pins. */
export function publicClipWhere() {
  return { OR: PUBLIC_CLIP_RIGHTS.map(entry => ({
    id: entry.id, sourceId: entry.sourceId, r2Key: entry.r2Key, posterR2Key: entry.posterR2Key,
    startSecs: entry.startSecs, endSecs: entry.endSecs, audioStripped: entry.audioStripped,
    deletedAt: null, source: { url: entry.sourceUrl, licence: entry.licence, rightsStatus: 'cleared' },
  })) };
}
