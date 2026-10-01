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
export type SensitivityReviewStatus = 'reviewed-safe';

/** Asked label bounds in the shared prompt/reveal image frame (0–1). */
export interface ImageRevealRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Strip unknown fields and reject malformed bounds before client projection. */
export function validImageRevealRegions(value: unknown): ImageRevealRegion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const regions: ImageRevealRegion[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const { x, y, width, height } = item;
    if (![x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n))
      || x < 0 || y < 0 || width <= 0 || height <= 0
      || x + width > 1 + 1e-9 || y + height > 1 + 1e-9) return undefined;
    regions.push({ x, y, width, height });
  }
  return regions;
}

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
  /** The ingest dialect for the bitmap size. `pickClientMeta` reads this OR
   *  imageWidth/imageHeight: 10,400 sidecars carry only this form and 2 carry
   *  the explicit pair (2026-09-16). */
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
  /**
   * Optional server-enforced ownership boundary for media belonging to a
   * personal deck. This remains authoritative even before the image is wired
   * to a seeded Card/Question row.
   */
  personalRotation?: string;
  /** Defaults to 'always'. 'after-reveal' hides the image until the user
   *  has answered/revealed (FeedImage + MCQ both honor this). */
  showWhen?: ShowWhen;
  /**
   * Opt-in consent gate for intimate or confronting clinical media, including
   * exposed genitals/breasts and visual depictions of obviously deceased
   * people. Metadata that merely says "postmortem" is insufficient when the
   * pixels are non-confronting diagnostic imaging.
   */
  sensitive?: boolean;
  /** Optional provenance for an explicit reviewed-safe note. Not required to
   *  show ordinary clinical photography. */
  sensitivityReviewStatus?: SensitivityReviewStatus;
  sensitivityReviewedAt?: string;
  sensitivityReviewedBy?: string;
  /** Optional stable `/figures/` key for the unoccluded/revealed form of an
   *  image prompt. Unlike a signed URL, this is safe to project to the client
   *  and persist in an offline pack. */
  revealImageKey?: string;
  revealRegions?: ImageRevealRegion[];
  /** Shared intrinsic frame, allowing reveal assets to load without resizing. */
  imageWidth?: number;
  imageHeight?: number;
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

export type SensitivityVerdict =
  | 'sensitive'
  | 'reviewed-safe'
  | 'clear'
  | 'invalid';

export interface SensitivityAssessment {
  verdict: SensitivityVerdict;
  issues: string[];
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/** Validate explicit sensitivity metadata. Gating itself is opt-in only. */
export function assessImageSensitivity(sidecar: ImageSidecar): SensitivityAssessment {
  const raw = sidecar as ImageSidecar & Record<string, unknown>;
  const issues: string[] = [];
  const status = raw.sensitivityReviewStatus;
  const reviewedAt = raw.sensitivityReviewedAt;
  const reviewedBy = raw.sensitivityReviewedBy;

  if (raw.sensitive !== undefined && typeof raw.sensitive !== 'boolean') {
    issues.push('sensitive must be a boolean when present');
  }
  if (status !== undefined && status !== 'reviewed-safe') {
    issues.push('sensitivityReviewStatus must be "reviewed-safe" when present');
  }
  if (status === undefined && (reviewedAt !== undefined || reviewedBy !== undefined)) {
    issues.push('sensitivity review provenance requires sensitivityReviewStatus');
  }
  if (status === 'reviewed-safe') {
    if (raw.sensitive === true) {
      issues.push('sensitive=true conflicts with sensitivityReviewStatus="reviewed-safe"');
    }
    if (!isCalendarDate(reviewedAt)) {
      issues.push('reviewed-safe requires sensitivityReviewedAt as a valid YYYY-MM-DD date');
    }
    if (typeof reviewedBy !== 'string' || reviewedBy.trim() === '') {
      issues.push('reviewed-safe requires sensitivityReviewedBy');
    }
  }

  if (issues.length > 0) return { verdict: 'invalid', issues };
  if (raw.sensitive === true) return { verdict: 'sensitive', issues };
  if (status === 'reviewed-safe') return { verdict: 'reviewed-safe', issues };
  return { verdict: 'clear', issues };
}

/** Only explicitly marked sensitive media is gated. */
export function shouldGateSensitiveMedia(sidecar: ImageSidecar): boolean {
  return assessImageSensitivity(sidecar).verdict === 'sensitive';
}

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
