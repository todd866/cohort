import { z } from 'zod';

const MAX_URL_LENGTH = 2_048;

const StableIdSchema = z.string().trim().min(1).max(160).regex(
  /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/,
  'must be a lowercase stable identifier',
);

const Sha256ReceiptSchema = z.string().regex(
  /^sha256:[a-f0-9]{64}$/,
  'must be a lowercase sha256:<64 hex characters> receipt',
);

const CalendarDateSchema = z.string().date();

const HttpsUrlSchema = z.string().trim().min(1).max(MAX_URL_LENGTH).url().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'must use https');

const RelativeAssetPathSchema = z.string().trim().min(1).max(500).refine((value) => {
  if (
    value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('%')
    || value.includes('?')
    || value.includes('#')
    || value.includes('//')
  ) {
    return false;
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  return /^[a-z0-9][a-z0-9._/-]*\.(?:jpe?g|png|webp|svg)$/.test(value);
}, 'must be a safe lowercase root-relative visual-asset path');

export const PUBLIC_VISUAL_LICENCE_IDS = [
  'CC0-1.0',
  'CC-BY-2.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC-BY-SA-3.0',
  'CC-BY-SA-4.0',
  'PD-USGov',
  'CC-BY-NC-3.0',
  'CC-BY-NC-SA-3.0',
  'CC-BY-NC-SA-4.0',
] as const;

export const PUBLIC_VISUAL_DISTRIBUTION_TIERS = [
  'foss',
  'public-noncommercial',
] as const;

export type PublicVisualDistributionTier = (
  typeof PUBLIC_VISUAL_DISTRIBUTION_TIERS[number]
);

const RightsSchema = z.object({
  licenceId: z.enum(PUBLIC_VISUAL_LICENCE_IDS),
  licenceUrl: HttpsUrlSchema,
  sourcePageUrl: HttpsUrlSchema,
  sourceAssetId: z.string().trim().min(1).max(300).optional(),
  sourceRevisionOrVersion: z.string().trim().min(1).max(300),
  attribution: z.string().trim().min(1).max(1_000),
  commercialUseAllowed: z.boolean(),
  shareAlike: z.boolean(),
}).strict();

const DerivationSchema = z.object({
  sourceSha256: Sha256ReceiptSchema,
  operation: z.enum([
    'authored-vector',
    'waveform-render',
    'lossless-copy',
    'privacy-crop',
  ]),
  parametersDigest: Sha256ReceiptSchema,
}).strict();

const ClinicalSchema = z.object({
  conditionIds: z.array(StableIdSchema).min(1).max(100),
  keyFindings: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
  reviewReceiptId: StableIdSchema,
  receiptVerifiedAt: CalendarDateSchema,
}).strict();

const SafetySchema = z.object({
  patientMedia: z.boolean(),
  humanSubject: z.boolean(),
  ageClass: z.enum(['adult', 'minor', 'not-applicable', 'unknown']),
  faceVisibility: z.enum(['none', 'lesion-macro-only', 'partial', 'full', 'unknown']),
  identityRisk: z.enum(['none', 'possible', 'identifiable', 'unknown']),
  bodyRegion: z.enum([
    'scalp',
    'face-lesion-crop',
    'oral-crop',
    'trunk',
    'upper-extremity',
    'lower-extremity',
    'hand',
    'foot',
    'not-applicable',
    'unknown',
  ]),
  sensitiveRegion: z.enum([
    'none',
    'genital',
    'perineal',
    'buttock',
    'breast',
    'diaper-groin-adjacent',
    'unknown',
  ]),
  consentBasis: z.enum([
    'source-publication',
    'source-release',
    'not-applicable',
    'unknown',
  ]),
  thumbnailPolicy: z.enum(['allow', 'deny']),
  reviewReceiptId: StableIdSchema,
  receiptVerifiedAt: CalendarDateSchema,
}).strict();

const AccessibilitySchema = z.object({
  preAnswerAlt: z.string().trim().min(1).max(1_000),
  postAnswerAlt: z.string().trim().min(1).max(2_000),
}).strict();

export const PublicVisualAssetV1Schema = z.object({
  schemaVersion: z.literal(1),
  assetId: StableIdSchema,
  relativePath: RelativeAssetPathSchema,
  sha256: Sha256ReceiptSchema,
  dimensions: z.object({
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
  }).strict(),
  sourceKind: z.enum(['authored-schematic', 'patient-derived']),
  modality: z.enum(['ecg', 'radiograph', 'clinical-photo', 'diagram']),
  distributionTier: z.enum(PUBLIC_VISUAL_DISTRIBUTION_TIERS),
  surfaceAllowlist: z.tuple([z.literal('cohort')]),
  rights: RightsSchema,
  derivation: DerivationSchema.optional(),
  clinical: ClinicalSchema,
  safety: SafetySchema,
  accessibility: AccessibilitySchema,
}).strict();

export type PublicVisualAssetV1 = z.infer<typeof PublicVisualAssetV1Schema>;

export const CohortDistributionPolicyV1Schema = z.object({
  schemaVersion: z.literal(1),
  commercialPosture: z.enum(['noncommercial-only', 'commercial']),
  noncommercialMediaEnabled: z.boolean(),
  allowedHosts: z.tuple([z.literal('cohort.md')]),
}).strict();

export type CohortDistributionPolicyV1 = z.infer<
  typeof CohortDistributionPolicyV1Schema
>;

const PublicVisualAssetManifestV1InputSchema = z.object({
  schemaVersion: z.literal(1),
  distributionTier: z.enum(PUBLIC_VISUAL_DISTRIBUTION_TIERS),
  assets: z.array(PublicVisualAssetV1Schema).max(10_000),
}).strict();

export const PublicVisualAssetManifestV1Schema = PublicVisualAssetManifestV1InputSchema;

type PublicVisualAssetManifestV1Input = z.infer<
  typeof PublicVisualAssetManifestV1InputSchema
>;

export interface PublicVisualAssetManifestV1 extends PublicVisualAssetManifestV1Input {
  assetById: Map<string, PublicVisualAssetV1>;
}

export function parsePublicVisualAssetV1(input: unknown): PublicVisualAssetV1 {
  return PublicVisualAssetV1Schema.parse(input);
}

export function parseCohortDistributionPolicyV1(
  input: unknown,
): CohortDistributionPolicyV1 {
  return CohortDistributionPolicyV1Schema.parse(input);
}

export function parsePublicVisualAssetManifestV1(
  input: unknown,
  expectedTier?: PublicVisualDistributionTier,
): PublicVisualAssetManifestV1 {
  const parsed = PublicVisualAssetManifestV1InputSchema.parse(input);
  if (expectedTier && parsed.distributionTier !== expectedTier) {
    throw new Error(
      `Expected ${expectedTier} visual-asset manifest, found ${parsed.distributionTier}`,
    );
  }

  const assetById = new Map<string, PublicVisualAssetV1>();
  const paths = new Set<string>();
  let previousAssetId: string | null = null;
  for (const asset of parsed.assets) {
    if (asset.distributionTier !== parsed.distributionTier) {
      throw new Error(
        `Asset ${asset.assetId} tier ${asset.distributionTier} does not match `
        + `${parsed.distributionTier} manifest tier`,
      );
    }
    if (assetById.has(asset.assetId)) {
      throw new Error(`Duplicate asset id ${asset.assetId}`);
    }
    if (paths.has(asset.relativePath)) {
      throw new Error(`Duplicate relative path ${asset.relativePath}`);
    }
    if (previousAssetId !== null && previousAssetId >= asset.assetId) {
      throw new Error('Visual assets must be sorted by assetId');
    }
    assetById.set(asset.assetId, asset);
    paths.add(asset.relativePath);
    previousAssetId = asset.assetId;
  }

  return { ...parsed, assetById };
}

/**
 * Fail-closed active-content scan for same-origin SVG prompt bytes. Internal
 * paint references such as `url(#grid)` are allowed; scripting, navigation,
 * embedded documents/media, animation, inline style, and remote references are
 * not. This is deliberately narrower than general SVG because these are static
 * teaching figures, not mini-applications.
 */
export function publicVisualSvgFailures(svg: string): string[] {
  const failures: string[] = [];
  if (svg.length === 0 || svg.length > 1_000_000) {
    failures.push('SVG must contain between 1 and 1,000,000 UTF-8 characters');
  }
  if (!/<svg\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(svg)) {
    failures.push('SVG root must declare the canonical SVG namespace');
  }

  const forbidden = [
    [/<\/?(?:script|foreignObject|iframe|object|embed|image|audio|video|canvas|a)\b/i,
      'embedded or active element'],
    [/<\/?(?:animate|animateMotion|animateTransform|set)\b/i, 'animation element'],
    [/\son[a-z][a-z0-9_-]*\s*=/i, 'event-handler attribute'],
    [/\sstyle\s*=/i, 'inline style attribute'],
    [/<!(?:DOCTYPE|ENTITY)\b/i, 'DTD or entity declaration'],
    [/<\?xml-stylesheet\b/i, 'external stylesheet instruction'],
    [/javascript\s*:/i, 'javascript URL'],
  ] as const;
  for (const [pattern, label] of forbidden) {
    if (pattern.test(svg)) failures.push(`SVG contains forbidden ${label}`);
  }

  for (const match of svg.matchAll(/(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi)) {
    if (!/^#[A-Za-z][A-Za-z0-9_.:-]*$/.test(match[1])) {
      failures.push('SVG href references must be local fragment identifiers');
      break;
    }
  }
  for (const match of svg.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)) {
    if (!/^#[A-Za-z][A-Za-z0-9_.:-]*$/.test(match[1])) {
      failures.push('SVG paint references must be local fragment identifiers');
      break;
    }
  }

  return [...new Set(failures)];
}

type PublicVisualReleaseTarget = 'cohort' | 'foss-export';
type PublicVisualManifestRoot = 'open-content' | 'rights-managed/cohort';

export interface PublicVisualAssetReleaseContext {
  target: PublicVisualReleaseTarget;
  manifestRoot: PublicVisualManifestRoot;
  intendedUse: 'prompt' | 'reveal' | 'thumbnail';
  host?: string;
  policy?: CohortDistributionPolicyV1 | null;
  /** ISO calendar date supplied explicitly by deterministic release tests. */
  today?: string;
}

interface LicenceRule {
  tier: PublicVisualDistributionTier;
  commercialUseAllowed: boolean;
  shareAlike: boolean;
  licencePath: string | null;
}

const LICENCE_RULES: Record<PublicVisualAssetV1['rights']['licenceId'], LicenceRule> = {
  'CC0-1.0': {
    tier: 'foss',
    commercialUseAllowed: true,
    shareAlike: false,
    licencePath: '/publicdomain/zero/1.0',
  },
  'CC-BY-2.0': {
    tier: 'foss',
    commercialUseAllowed: true,
    shareAlike: false,
    licencePath: '/licenses/by/2.0',
  },
  'CC-BY-3.0': {
    tier: 'foss',
    commercialUseAllowed: true,
    shareAlike: false,
    licencePath: '/licenses/by/3.0',
  },
  'CC-BY-4.0': {
    tier: 'foss',
    commercialUseAllowed: true,
    shareAlike: false,
    licencePath: '/licenses/by/4.0',
  },
  'CC-BY-SA-3.0': {
    tier: 'foss',
    commercialUseAllowed: true,
    shareAlike: true,
    licencePath: '/licenses/by-sa/3.0',
  },
  'CC-BY-SA-4.0': {
    tier: 'foss',
    commercialUseAllowed: true,
    shareAlike: true,
    licencePath: '/licenses/by-sa/4.0',
  },
  'PD-USGov': {
    tier: 'foss',
    commercialUseAllowed: true,
    shareAlike: false,
    licencePath: null,
  },
  'CC-BY-NC-3.0': {
    tier: 'public-noncommercial',
    commercialUseAllowed: false,
    shareAlike: false,
    licencePath: '/licenses/by-nc/3.0',
  },
  'CC-BY-NC-SA-3.0': {
    tier: 'public-noncommercial',
    commercialUseAllowed: false,
    shareAlike: true,
    licencePath: '/licenses/by-nc-sa/3.0',
  },
  'CC-BY-NC-SA-4.0': {
    tier: 'public-noncommercial',
    commercialUseAllowed: false,
    shareAlike: true,
    licencePath: '/licenses/by-nc-sa/4.0',
  },
};

function normalizedUrlPath(url: URL): string {
  return url.pathname.replace(/\/+$/, '').toLowerCase();
}

function licenceReceiptFailure(asset: PublicVisualAssetV1, rule: LicenceRule): string | null {
  const url = new URL(asset.rights.licenceUrl);
  const hostname = url.hostname.toLowerCase();
  if (asset.rights.licenceId === 'PD-USGov') {
    if (hostname !== 'gov' && !hostname.endsWith('.gov')) {
      return 'PD-USGov licence receipt must resolve to an official .gov rights page';
    }
    return null;
  }
  if (hostname !== 'creativecommons.org' || normalizedUrlPath(url) !== rule.licencePath) {
    return `${asset.rights.licenceId} licence receipt must use its exact Creative Commons URL`;
  }
  return null;
}

function normalizedWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function dateIsAfter(left: string, right: string): boolean {
  return Date.parse(`${left}T00:00:00.000Z`) > Date.parse(`${right}T00:00:00.000Z`);
}

const MAX_REVIEW_AGE_MS = 365 * 24 * 60 * 60 * 1_000;

function receiptVerificationIsStale(verifiedAt: string, today: string): boolean {
  return Date.parse(`${today}T00:00:00.000Z`)
    - Date.parse(`${verifiedAt}T00:00:00.000Z`) > MAX_REVIEW_AGE_MS;
}

function assertToday(today: string): void {
  if (!CalendarDateSchema.safeParse(today).success) {
    throw new Error('today must be an ISO 8601 calendar date');
  }
}

/**
 * Pure release/serving gate for one already parsed asset.
 *
 * Structural parsing and policy eligibility remain separate so tests can prove
 * that a syntactically valid policy hard-offs NC media when its posture flips.
 */
export function publicVisualAssetReleaseFailures(
  asset: PublicVisualAssetV1,
  context: PublicVisualAssetReleaseContext,
): string[] {
  const failures: string[] = [];
  const today = context.today ?? new Date().toISOString().slice(0, 10);
  assertToday(today);

  if (context.target === 'cohort' && context.host !== 'cohort.md') {
    failures.push('Visual assets may be served only on cohort.md');
  }

  const requiredRoot = asset.distributionTier === 'foss'
    ? 'open-content'
    : 'rights-managed/cohort';
  if (context.manifestRoot !== requiredRoot) {
    failures.push(
      `${asset.distributionTier} asset ${asset.assetId} must live under ${requiredRoot}`,
    );
  }

  const licenceRule = LICENCE_RULES[asset.rights.licenceId];
  if (licenceRule.tier !== asset.distributionTier) {
    failures.push(
      licenceRule.tier === 'public-noncommercial'
        ? `NC licence ${asset.rights.licenceId} requires distributionTier=public-noncommercial`
        : `FOSS-compatible licence ${asset.rights.licenceId} requires the foss tier`,
    );
  }
  if (asset.rights.commercialUseAllowed !== licenceRule.commercialUseAllowed) {
    failures.push(
      `${asset.rights.licenceId} requires commercialUseAllowed=${licenceRule.commercialUseAllowed}`,
    );
  }
  if (asset.rights.shareAlike !== licenceRule.shareAlike) {
    failures.push(`${asset.rights.licenceId} requires shareAlike=${licenceRule.shareAlike}`);
  }
  const licenceFailure = licenceReceiptFailure(asset, licenceRule);
  if (licenceFailure) failures.push(licenceFailure);

  if (asset.distributionTier === 'public-noncommercial') {
    if (context.target === 'foss-export') {
      failures.push('public-noncommercial assets are forbidden from the FOSS export');
    }
    if (!context.policy) {
      failures.push('A checked-in Cohort distribution policy is required for NC media');
    } else {
      if (context.policy.commercialPosture !== 'noncommercial-only') {
        failures.push('NC media is disabled under the commercial posture');
      }
      if (!context.policy.noncommercialMediaEnabled) {
        failures.push('Noncommercial media is disabled by Cohort distribution policy');
      }
      if (!context.policy.allowedHosts.includes('cohort.md')) {
        failures.push('Cohort distribution policy must allow cohort.md');
      }
    }
  }

  const safety = asset.safety;
  const patientOrHuman = safety.patientMedia || safety.humanSubject;
  const patientDerived = asset.sourceKind === 'patient-derived';
  const deidentifiedEcgWaveform = patientDerived
    && asset.modality === 'ecg'
    && asset.derivation?.operation === 'waveform-render';
  if (patientDerived && (!safety.patientMedia || !safety.humanSubject)) {
    const label = asset.modality === 'ecg'
      ? 'An ECG'
      : asset.modality === 'clinical-photo'
        ? 'A clinical photo'
        : 'A radiograph';
    failures.push(`${label} must declare patientMedia=true and humanSubject=true`);
  }
  if (asset.sourceKind === 'authored-schematic') {
    if (patientOrHuman) {
      failures.push('An authored schematic cannot be declared as patient media or a human subject');
    }
    if (asset.modality !== 'diagram') {
      failures.push('Cohort ECGs must be patient-derived recorded waveforms, not authored schematics');
    }
    if (asset.derivation?.operation !== 'authored-vector') {
      failures.push('An authored schematic requires an authored-vector provenance receipt');
    }
  } else if (asset.modality === 'diagram') {
    failures.push('A patient-derived asset cannot use the diagram modality');
  } else if (asset.derivation?.operation === 'authored-vector') {
    failures.push('Patient-derived media cannot use an authored-vector provenance receipt');
  }

  if (
    asset.sourceKind === 'patient-derived'
    && asset.modality === 'ecg'
    && asset.derivation?.operation !== 'waveform-render'
  ) {
    failures.push('A patient-derived ECG requires a waveform-render derivation receipt');
  }

  if (context.intendedUse === 'thumbnail' && safety.thumbnailPolicy !== 'allow') {
    failures.push(`Thumbnail use is denied for asset ${asset.assetId}`);
  }

  if (patientDerived || patientOrHuman) {
    if (safety.ageClass === 'unknown') {
      failures.push('Patient media age class must not be unknown');
    }
    if (safety.ageClass === 'not-applicable' && !deidentifiedEcgWaveform) {
      failures.push('Patient media age class must identify adult or minor');
    }
    if (safety.faceVisibility === 'unknown') {
      failures.push('Patient media face visibility must not be unknown');
    }
    if (safety.identityRisk === 'unknown') {
      failures.push('Patient media identity risk must not be unknown');
    }
    if (safety.bodyRegion === 'unknown') {
      failures.push('Patient media body region must not be unknown');
    }
    if (safety.bodyRegion === 'not-applicable' && !deidentifiedEcgWaveform) {
      failures.push('Patient media body region must be explicit');
    }
    if (safety.consentBasis === 'unknown') {
      failures.push('Patient media consent basis must not be unknown');
    }
    if (safety.consentBasis === 'not-applicable') {
      failures.push('Patient media consent basis must identify a source publication or release');
    }
    if (safety.sensitiveRegion !== 'none') {
      failures.push(`Patient media sensitive region is ${safety.sensitiveRegion}; release requires none`);
    }

    if (safety.ageClass === 'minor') {
      if (!['none', 'lesion-macro-only'].includes(safety.faceVisibility)) {
        failures.push(
          'A minor clinical photo must not expose facial geometry beyond a lesion-only macro crop',
        );
      }
      if (safety.identityRisk !== 'none') {
        failures.push('A minor clinical photo identity risk must be none');
      }
    } else if (safety.identityRisk === 'possible' || safety.identityRisk === 'identifiable') {
      failures.push('Patient media identity risk must be none');
    }
  }

  if (dateIsAfter(asset.clinical.receiptVerifiedAt, today)) {
    failures.push(`Clinical receipt verification date ${asset.clinical.receiptVerifiedAt} is in the future`);
  }
  if (dateIsAfter(asset.safety.receiptVerifiedAt, today)) {
    failures.push(`Safety receipt verification date ${asset.safety.receiptVerifiedAt} is in the future`);
  }
  if (receiptVerificationIsStale(asset.clinical.receiptVerifiedAt, today)) {
    failures.push(`Clinical receipt verification date ${asset.clinical.receiptVerifiedAt} is more than 365 days old`);
  }
  if (receiptVerificationIsStale(asset.safety.receiptVerifiedAt, today)) {
    failures.push(`Safety receipt verification date ${asset.safety.receiptVerifiedAt} is more than 365 days old`);
  }

  const preAnswerAlt = normalizedWords(asset.accessibility.preAnswerAlt);
  for (const conditionId of asset.clinical.conditionIds) {
    const condition = normalizedWords(conditionId);
    if (condition.length >= 4 && preAnswerAlt.includes(condition)) {
      failures.push(`Pre-answer alt text reveals condition ${conditionId}`);
    }
  }

  return failures;
}
