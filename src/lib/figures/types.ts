import type {
  ImageSidecar,
  AccessTier,
  ShowWhen,
  Modality,
  AltPolicy,
  ImageRevealRegion,
} from '@/lib/images/types';
import { assessImageSensitivity, validImageRevealRegions } from '@/lib/images/types';

/** The subset of sidecar data the client needs to render correctly.
 *  Allowlist: any new sidecar field must be explicitly added here to
 *  reach the client.
 *
 *  Note: answer-bearing alt text is never pre-baked here. A reviewed
 *  diagnosis-neutral `preAnswerAlt` may cross this boundary; descriptive key
 *  findings remain reveal-gated. The client computes the active alt at render
 *  time via `imageAltForMeta(meta, revealed)`. */
export interface ClientImageMeta {
  accessTier: AccessTier;
  showWhen: ShowWhen;
  /** Opt-in consent gate. Only true when the sidecar explicitly marks
   *  genitals or obviously deceased people. */
  sensitive?: boolean;
  /** Stable key for an alternate image to display once the answer is revealed. */
  revealImageKey?: string;
  revealRegions?: ImageRevealRegion[];
  imageWidth?: number;
  imageHeight?: number;
  class: 'diagnostic' | 'diagram' | 'decorative' | 'lake-reference';
  altPolicy: AltPolicy;
  /** Reviewed, diagnosis-neutral description safe to expose before grading. */
  preAnswerAlt?: string;
  attributionText: string;
  /** Reviewed public licence/source link shown with the attribution when present. */
  licenseUrl?: string;
  /** Reviewed page identifying the original source asset or corpus. */
  sourcePageUrl?: string;
  // diagnostic-only
  condition?: string;
  modality?: Modality;
  keyFindings?: string[];
  // diagram + lake-reference
  topic?: string;
}

export type ResolvedImage =
  | { imageKey: string; imageUrl: string; imageMeta: ClientImageMeta | undefined };

/** Optional, reviewed explanatory media. The existing primary image stays separate. */
export interface ResolvedImageAlternative {
  imageKey: string;
  imageUrl: string;
  imageCaption: string;
  imageRole: null;
  imageMeta: ClientImageMeta;
}

/** Gate only when the client projection explicitly opts in. */
export function shouldGateClientImageMeta(
  meta: ClientImageMeta | undefined | null,
  _imageKey?: string | null,
): boolean {
  void _imageKey;
  return meta?.sensitive === true;
}

/**
 * The bitmap size a sidecar declares, in either dialect: `imageWidth`/
 * `imageHeight`, or the ingest form `dimensions: {w, h}`. The explicit pair
 * wins when both are present. Until 2026-09-16 only the first was read, so
 * the ~10,400 sidecars written in the second form reached the layout with no
 * size at all — a 2:1 composite was laid out as an unknown shape.
 */
export function sidecarDimensions(s: ImageSidecar): { width: number; height: number } | null {
  const pairs: Array<[unknown, unknown]> = [
    [s.imageWidth, s.imageHeight],
    [s.dimensions?.w, s.dimensions?.h],
  ];
  for (const [w, h] of pairs) {
    if (Number.isInteger(w) && Number.isInteger(h) && (w as number) > 0 && (h as number) > 0) {
      return { width: w as number, height: h as number };
    }
  }
  return null;
}

export function pickClientMeta(s: ImageSidecar, _imageKey?: string): ClientImageMeta {
  void _imageKey;
  const assessment = assessImageSensitivity(s);
  const sensitive = assessment.verdict === 'sensitive' ? true : undefined;
  const base: ClientImageMeta = {
    accessTier: s.accessTier ?? 'public',
    showWhen: s.showWhen ?? 'always',
    sensitive,
    revealImageKey: s.revealImageKey,
    revealRegions: validImageRevealRegions(s.revealRegions),
    class: s.class,
    altPolicy: 'altPolicy' in s ? s.altPolicy : 'generic',
    attributionText: s.attributionText,
    licenseUrl: s.licenseUrl || undefined,
  };
  const size = sidecarDimensions(s);
  if (size) {
    base.imageWidth = size.width;
    base.imageHeight = size.height;
  }
  if (s.class === 'diagnostic') {
    base.condition = s.condition;
    base.modality = s.modality;
    base.keyFindings = s.keyFindings;
  } else if (s.class === 'diagram') {
    base.topic = s.caption;
  } else if (s.class === 'lake-reference') {
    base.topic = s.topic;
  }
  return base;
}

const GENERIC_ALT_BY_MODALITY: Partial<Record<string, string>> = {
  photo: 'clinical photograph',
  cxr: 'chest X-ray',
  ct: 'CT image',
  mri: 'MRI image',
  ecg: 'ECG',
  us: 'ultrasound image',
  otoscopy: 'otoscopic view',
  fundoscopy: 'fundoscopic image',
  derm: 'clinical photograph',
  histology: 'histology slide',
  other: 'clinical image',
};

/** Compute alt text from projected meta + reveal state.
 *  Safe to call on the client. */
export function imageAltForMeta(meta: ClientImageMeta, revealed: boolean): string {
  if (meta.class === 'diagnostic') {
    const generic = (meta.modality && GENERIC_ALT_BY_MODALITY[meta.modality]) ?? 'clinical image';
    if (!revealed && meta.preAnswerAlt) return meta.preAnswerAlt;
    if (meta.altPolicy === 'descriptive' && revealed && meta.modality && meta.keyFindings) {
      return `${generic}: ${meta.keyFindings.join('; ')}`;
    }
    return generic;
  }
  if (meta.class === 'diagram' || meta.class === 'lake-reference') {
    return meta.topic ?? '';
  }
  return ''; // decorative
}
