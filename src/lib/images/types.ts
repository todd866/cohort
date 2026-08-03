export type ImageClass = 'diagnostic' | 'diagram' | 'decorative' | 'lake-reference';
export type UsageTier =
  | 'public-ok'
  | 'public-attribution'
  | 'restricted-review-only'
  | 'do-not-use';
export type Modality =
  | 'photo' | 'cxr' | 'ct' | 'mri' | 'ecg' | 'us'
  | 'otoscopy' | 'fundoscopy' | 'derm' | 'histology' | 'other';
export type AltPolicy = 'generic' | 'descriptive';
export type AccessTier = 'public' | 'auth-required' | 'copyright-required';
export type ShowWhen = 'always' | 'after-reveal';
export type ClinicalReviewStatus = 'pending' | 'complete';

interface SidecarBase {
  usageTier: UsageTier;
  source: string;
  sourcePage: string;
  directImageUrl: string;
  license: string;
  licenseUrl: string;
  attributionText: string;
  noOptimize?: boolean;
  hash: string;
  dimensions: { w: number; h: number };
  addedBy: string;
  addedAt: string;
  humanReviewedAt?: string;
  humanReviewedBy?: string;
  /** Explicitly distinguishes provenance/visual QA from clinician review. */
  clinicalReviewStatus?: ClinicalReviewStatus;
  // Reserved for future patient-photo tier; v1 rejects true.
  containsIdentifiablePatient?: boolean;
  consentBasis?: string;
  deidentified?: boolean;
  /** Defaults to 'public'. Lake/restricted images use 'auth-required'. */
  accessTier?: AccessTier;
  /** Defaults to 'always'. 'after-reveal' hides the image until the user
   *  has answered/revealed (FeedImage + MCQ both honor this). */
  showWhen?: ShowWhen;
  /** Defaults to false. When true the image renders blurred with a
   *  tap-to-reveal overlay (clinical genital/STI photos etc.) so it isn't
   *  displayed openly until the user opts in. */
  sensitive?: boolean;
}

export interface DiagnosticSidecar extends SidecarBase {
  class: 'diagnostic';
  condition: string;
  keyFindings: string[];
  modality: Modality;
  age?: string;
  region?: string;
  altPolicy: AltPolicy;
}

export interface DiagramSidecar extends SidecarBase {
  class: 'diagram';
  topic: string;
  caption: string;
  altPolicy: 'descriptive';
}

export interface DecorativeSidecar extends SidecarBase {
  class: 'decorative';
  altPolicy: 'generic';
}

export interface LakeReferenceSidecar extends SidecarBase {
  class: 'lake-reference';
  /** Best-effort topic label from the matcher. NOT clinically reviewed. */
  topic: string;
  /** content_lake item id this image was sourced from. */
  lakeSourceId: string;
  altPolicy: 'generic';
}

export type ImageSidecar =
  | DiagnosticSidecar
  | DiagramSidecar
  | DecorativeSidecar
  | LakeReferenceSidecar;

export const isDiagnostic = (s: ImageSidecar): s is DiagnosticSidecar =>
  s.class === 'diagnostic';
export const isDiagram = (s: ImageSidecar): s is DiagramSidecar =>
  s.class === 'diagram';
export const isDecorative = (s: ImageSidecar): s is DecorativeSidecar =>
  s.class === 'decorative';
export const isLakeReference = (s: ImageSidecar): s is LakeReferenceSidecar =>
  s.class === 'lake-reference';

export function resolveAccessTier(v: unknown): AccessTier {
  if (v === 'copyright-required') return 'copyright-required';
  return v === 'auth-required' ? 'auth-required' : 'public';
}

export function resolveShowWhen(v: unknown): ShowWhen {
  return v === 'after-reveal' ? 'after-reveal' : 'always';
}

export interface ImageGap {
  targetKind: 'mcq-mdx' | 'mcq-json' | 'figure-mdx' | 'keypoint-mdx' | 'needimage-mdx';
  file: string;
  line: number | null;
  componentIndex?: number;
  mcqId?: string;
  jsonPath?: string;
  reason: 'placeholder' | 'visual-cue' | 'visual-topic' | 'broken-link';
  suggestedCondition?: string;
  suggestedFinding?: string;
  suggestedModality?: Modality;
  contentSnippet: string;
  priorityScore: number;
}

export interface SourceCandidate {
  url: string;
  thumbnailUrl: string;
  sourcePage: string;
  sourceTitle: string;
  license: { id: string; url: string; raw: string };
  author?: string;
  caption?: string;
  width?: number;
  height?: number;
  dermnetWatermark?: boolean;
}
