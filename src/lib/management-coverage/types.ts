export type ManagementCoverageStatus = 'active' | 'planned';

export type ManagementCoverageLinkKind = 'question' | 'mdx-section' | 'card';

export type ManagementCoverageLinkStrength = 'primary' | 'supporting' | 'adjacent';

export interface ManagementCoverageLink {
  kind: ManagementCoverageLinkKind;
  id: string;
  strength: ManagementCoverageLinkStrength;
  note?: string;
}

export interface ManagementCoverageBranch {
  id: string;
  status?: ManagementCoverageStatus;
  modifiers: string[];
  expectedBestAction?: string;
  expectedAvoidActions?: string[];
  rationale: string;
  commonTraps?: string[];
  linkedContent?: ManagementCoverageLink[];
  calibrationLinks?: string[];
  notes?: string;
}

export interface ManagementCoverageFamily {
  id: string;
  sourceFile?: string;
  title: string;
  rotation: string;
  baseScenario: string;
  task: string;
  notes?: string;
  branches: ManagementCoverageBranch[];
}

export type CoverageLevel = 'none' | 'weak' | 'adequate';

export type ReviewExposure = 'yes' | 'no' | 'unknown';

export interface ManagementCoverageBranchAudit {
  familyId: string;
  branchId: string;
  status: ManagementCoverageStatus;
  modifiers: string[];
  questionCoverage: CoverageLevel;
  supportCoverage: CoverageLevel;
  examCalibrationEvidence: 'yes' | 'no' | 'unknown';
  reviewExposure: ReviewExposure;
  issues: string[];
  missingLinks: string[];
}

export interface ManagementCoverageFamilyAudit {
  id: string;
  title: string;
  rotation: string;
  branches: ManagementCoverageBranchAudit[];
}

export interface ManagementCoverageAuditSummary {
  families: number;
  branches: number;
  uncoveredBranches: number;
  weakQuestionCoverageBranches: number;
  factOnlyBranches: number;
  calibrationWithoutQuestionCoverage: number;
  noReviewExposureBranches: number;
  missingLinks: number;
  unmodeledCalibrationLinks: number;
}

export interface ManagementCoverageAuditReport {
  families: ManagementCoverageFamilyAudit[];
  summary: ManagementCoverageAuditSummary;
  unmodeledCalibrationLinks: string[];
}
