import registry from './sensitive-clips.json';

/**
 * Clips whose footage is intimate or confronting: genital, perineal, vulval,
 * vaginal or cervical exposure, birth, or open surgery on a visible patient.
 * The rule and the review method are stated in the JSON beside each entry's
 * reason, so the list is reviewed content, not a judgement inside code.
 *
 * Keyed by `VideoClip.slug`, the stable authoring handle a re-cut keeps.
 * Delivery marks these clips `sensitive`; with "Blur images" on, review then
 * holds them behind the shared sensitive-media gate and they do not start by
 * themselves until the learner shows them.
 */
export const SENSITIVE_CLIP_SLUGS: ReadonlySet<string> = new Set(registry.clips.map((clip) => clip.slug));

export function isSensitiveClipSlug(slug: string | null | undefined): boolean {
  return Boolean(slug && SENSITIVE_CLIP_SLUGS.has(slug));
}
