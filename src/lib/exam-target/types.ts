export const YEAR3_EXAM_TARGET_ROTATIONS = [
  'critical-care',
  'paam',
  'cah',
  'pwh',
] as const;

export type ExamTargetRotation = (typeof YEAR3_EXAM_TARGET_ROTATIONS)[number];
export type ExamTargetServingStatus = 'shadow' | 'limited' | 'active' | 'retired';
export type ExamTargetBasis = 'official' | 'hybrid' | 'proxy';
export type ExamTargetAuthority =
  | 'official-assessment-report'
  | 'institution-practice'
  | 'specialty-society-practice'
  | 'official-curriculum'
  | 'internal-curation';
export type ExamTargetEvidenceRole =
  | 'taxonomy'
  | 'weights'
  | 'geometry'
  | 'outcome'
  | 'curriculum';
export type ExamTargetAnchorSupport =
  | 'sufficient'
  | 'provisional'
  | 'sparse'
  | 'missing';

export interface ExamTargetEvidenceRef {
  role: ExamTargetEvidenceRole;
  authority: ExamTargetAuthority;
  /** Stable logical identifier. Filesystem paths are forbidden at runtime. */
  sourceId: string;
  sourceDate?: string;
  sha256: string;
  /** Whether the source itself contains verbatim assessment content. */
  verbatim: boolean;
  /** Whether the source itself, rather than this metadata ref, may ship. */
  runtimeSafe: boolean;
}

export interface ExamTargetReportingGroup {
  code: string;
  label: string;
  questionCount: number;
}

export interface ExamTargetDomain {
  code: string;
  label: string;
  parentCode?: string;
  aliases: string[];
  questionCount?: number;
  anchorCount: number;
  /** Official question share or raw proxy anchor share. */
  rawWeight: number;
  /** Runtime weight after the target's declared weighting policy. */
  effectiveWeight: number;
  weightAuthority: 'official' | 'proxy';
  /** Anchor-count support only; geometry quality is validated in a snapshot. */
  anchorSupport: ExamTargetAnchorSupport;
  clinicallyCritical?: boolean;
}

export interface ExamTargetInfluencePolicy {
  allocator: 'full' | 'soft' | 'shadow';
  maxItemRankMove: number;
  conceptMultiplierMin: number;
  conceptMultiplierMax: number;
}

export type ExamTargetWeightPolicy =
  | { kind: 'official-question-count'; totalQuestions: number }
  | { kind: 'proxy-shrunk-anchor-share'; proxyShare: 0.5 };

export interface ExamTargetSourceDomain {
  code: string;
  label: string;
  parentCode?: string;
  aliases: string[];
  questionCount?: number;
  anchorCount: number;
  clinicallyCritical?: boolean;
}

/** Checked-in safe source facts; policy-derived values are intentionally absent. */
export interface ExamTargetRegistrySource {
  schema: 'md3.exam-target/v1';
  targetId: string;
  revision: number;
  rotation: ExamTargetRotation;
  servingStatus: ExamTargetServingStatus;
  validFrom: string;
  evidence: ExamTargetDefinition['evidence'];
  reportingGroups?: ExamTargetReportingGroup[];
  weightPolicy: ExamTargetWeightPolicy;
  domains: ExamTargetSourceDomain[];
  scoringPolicyVersion: string;
  embeddingModel: string;
  embeddingDimensions: number;
  anchorCorpusHash: string;
  reviewedBy: string;
  reviewedAt: string;
}

/**
 * Sanitized, runtime-readable exam target definition. Raw questions,
 * embeddings, personal outcomes and private paths are deliberately absent.
 */
export interface ExamTargetDefinition {
  schema: 'md3.exam-target/v1';
  targetId: string;
  revision: number;
  rotation: ExamTargetRotation;
  servingStatus: ExamTargetServingStatus;
  targetBasis: ExamTargetBasis;
  validFrom: string;
  evidence: {
    taxonomy: ExamTargetEvidenceRef;
    weights: ExamTargetEvidenceRef;
    geometry: ExamTargetEvidenceRef[];
    outcomes: ExamTargetEvidenceRef[];
    curriculum: ExamTargetEvidenceRef[];
  };
  reportingGroups?: ExamTargetReportingGroup[];
  domains: ExamTargetDomain[];
  influence: ExamTargetInfluencePolicy;
  scoringPolicyVersion: string;
  embeddingModel: string;
  embeddingDimensions: number;
  anchorCorpusHash: string;
  reviewedBy: string;
  reviewedAt: string;
}

export interface ExamTargetRuntimeArtifact extends ExamTargetDefinition {
  runtimeArtifactHash: string;
}
