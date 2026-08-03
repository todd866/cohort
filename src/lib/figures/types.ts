import type {
  ImageSidecar,
  AccessTier,
  ShowWhen,
  Modality,
  AltPolicy,
} from '@/lib/images/types';

/** The subset of sidecar data the client needs to render correctly.
 *  Allowlist: any new sidecar field must be explicitly added here to
 *  reach the client.
 *
 *  Note: alt text is NOT pre-baked here. It depends on whether the
 *  user has revealed the answer (descriptive alt leaks findings).
 *  The client computes alt at render time via `imageAltForMeta(meta, revealed)`. */
export interface ClientImageMeta {
  accessTier: AccessTier;
  showWhen: ShowWhen;
  /** When true the client renders the image blurred behind a tap-to-reveal
   *  overlay (sensitive clinical photos). */
  sensitive?: boolean;
  class: 'diagnostic' | 'diagram' | 'decorative' | 'lake-reference';
  altPolicy: AltPolicy;
  attributionText: string;
  // diagnostic-only
  condition?: string;
  modality?: Modality;
  keyFindings?: string[];
  // diagram + lake-reference
  topic?: string;
}

export type ResolvedImage =
  | { imageKey: string; imageUrl: string; imageMeta: ClientImageMeta | undefined };

export function pickClientMeta(s: ImageSidecar): ClientImageMeta {
  const base: ClientImageMeta = {
    accessTier: s.accessTier ?? 'public',
    showWhen: s.showWhen ?? 'always',
    sensitive: s.sensitive === true ? true : undefined,
    class: s.class,
    altPolicy: 'altPolicy' in s ? s.altPolicy : 'generic',
    attributionText: s.attributionText,
  };
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
