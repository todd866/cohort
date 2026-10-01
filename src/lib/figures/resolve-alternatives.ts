import 'server-only';
import type { Session } from 'next-auth';
import type { AccessTier } from '@/lib/images/types';
import { getOriginalImageAlternatives, type OriginalImageIdentity } from './original-image-alternatives';
import { getOriginalFigure, ORIGINAL_FIGURE_PREFIX } from './original-figure-manifest';
import { questionImageIsPrompt, resolveImage } from './resolve';
import { imageAlternativeTeachingFingerprint, type ImageAlternativeTeachingSource } from './image-alternative-fingerprint';
import type { ResolvedImageAlternative } from './types';

/**
 * Add reviewed, public teaching choices without changing the primary image.
 * Call only after validating the item's current source and required prompt.
 * Optional enrichment failure must never remove otherwise deliverable content.
 */
export async function resolveImageAlternatives(
  identity: OriginalImageIdentity & ImageAlternativeTeachingSource & { imageRole?: string | null },
  primaryKey: string | null,
  session: Session | null,
  trustOverride?: AccessTier,
): Promise<ResolvedImageAlternative[]> {
  try {
    const candidates = getOriginalImageAlternatives({ type: identity.type, id: identity.id });
    if (candidates.length === 0) return [];
    // Inspect legacy metadata even for an unexpected non-null stored role.
    if (identity.imageRole === 'prompt' || questionImageIsPrompt(null, primaryKey)) return [];
    const teachingFingerprint = imageAlternativeTeachingFingerprint(identity);
    if (!teachingFingerprint) return [];
    const seen = new Set<string>();
    const alternatives = await Promise.all(candidates.map(async (candidate): Promise<ResolvedImageAlternative | null> => {
      try {
        if (candidate.expectedPrimaryKey !== primaryKey || candidate.teachingFingerprint !== teachingFingerprint) return null;
        const key = `${ORIGINAL_FIGURE_PREFIX}${candidate.figureId}.png`;
        if (key === primaryKey || seen.has(key)) return null;
        const figure = getOriginalFigure(key);
        if (!figure || figure.teaching.imageRole !== 'after-reveal') return null;
        seen.add(key);
        const resolved = await resolveImage(key, session, trustOverride);
        if (!resolved || resolved.imageKey !== key || resolved.imageUrl !== key
          || resolved.imageMeta?.accessTier !== 'public'
          || resolved.imageMeta.class !== 'diagram'
          || resolved.imageMeta.showWhen !== 'after-reveal') return null;
        return {
          imageKey: key,
          imageUrl: key,
          imageCaption: candidate.imageCaption,
          imageRole: null,
          imageMeta: resolved.imageMeta,
        };
      } catch {
        return null;
      }
    }));
    return alternatives.filter((alternative): alternative is ResolvedImageAlternative => alternative !== null);
  } catch {
    return [];
  }
}
