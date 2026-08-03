import type {
  CoverageLevel,
  ManagementCoverageAuditReport,
  ManagementCoverageBranch,
  ManagementCoverageBranchAudit,
  ManagementCoverageFamily,
  ManagementCoverageFamilyAudit,
  ReviewExposure,
} from './types';

export interface ManagementCoverageAuditInputs {
  questionIds: Set<string>;
  mdxSectionIds: Set<string>;
  calibrationLinkIds?: Set<string>;
  cardIds?: Set<string>;
  seenQuestionIds?: Set<string>;
}

function scoreQuestionCoverage(
  primaryQuestions: number,
  totalQuestions: number,
  primarySupportLinks: number
): CoverageLevel {
  if (totalQuestions === 0) return 'none';
  if (primaryQuestions >= 1 && (totalQuestions >= 2 || primarySupportLinks >= 1)) return 'adequate';
  return 'weak';
}

function scoreSupportCoverage(primarySupportLinks: number, totalSupportLinks: number): CoverageLevel {
  if (totalSupportLinks === 0) return 'none';
  if (primarySupportLinks >= 1 || totalSupportLinks >= 2) return 'adequate';
  return 'weak';
}

function resolveReviewExposure(
  seenQuestionIds: Set<string> | undefined,
  resolvedQuestionIds: string[]
): ReviewExposure {
  if (!seenQuestionIds) return 'unknown';
  if (resolvedQuestionIds.some((id) => seenQuestionIds.has(id))) return 'yes';
  return 'no';
}

function auditBranch(
  familyId: string,
  branch: ManagementCoverageBranch,
  inputs: ManagementCoverageAuditInputs,
  resolvedCalibrationLinks: Set<string>
): ManagementCoverageBranchAudit {
  const status = branch.status ?? 'active';
  const issues: string[] = [];
  const missingLinks: string[] = [];

  let totalQuestions = 0;
  let primaryQuestions = 0;
  let totalSupportLinks = 0;
  let primarySupportLinks = 0;
  const resolvedQuestionIds: string[] = [];

  for (const link of branch.linkedContent ?? []) {
    let exists = false;

    if (link.kind === 'question') {
      exists = inputs.questionIds.has(link.id);
      if (exists) {
        totalQuestions += 1;
        resolvedQuestionIds.push(link.id);
        if (link.strength === 'primary') primaryQuestions += 1;
      }
    } else if (link.kind === 'mdx-section') {
      exists = inputs.mdxSectionIds.has(link.id);
      if (exists) {
        totalSupportLinks += 1;
        if (link.strength === 'primary') primarySupportLinks += 1;
      }
    } else if (link.kind === 'card') {
      exists = inputs.cardIds?.has(link.id) ?? false;
      if (exists) {
        totalSupportLinks += 1;
        if (link.strength === 'primary') primarySupportLinks += 1;
      }
    }

    if (!exists) {
      missingLinks.push(`${link.kind}:${link.id}`);
    }
  }

  let existingCalibrationLinks = 0;
  if (inputs.calibrationLinkIds) {
    for (const calibrationLink of branch.calibrationLinks ?? []) {
      if (inputs.calibrationLinkIds.has(calibrationLink)) {
        existingCalibrationLinks += 1;
        resolvedCalibrationLinks.add(calibrationLink);
      } else {
        missingLinks.push(`talk-page:${calibrationLink}`);
      }
    }
  }

  const questionCoverage = scoreQuestionCoverage(primaryQuestions, totalQuestions, primarySupportLinks);
  const supportCoverage = scoreSupportCoverage(primarySupportLinks, totalSupportLinks);
  const examCalibrationEvidence =
    existingCalibrationLinks > 0 ? 'yes' : branch.calibrationLinks?.length ? 'unknown' : 'no';
  const reviewExposure = resolveReviewExposure(inputs.seenQuestionIds, resolvedQuestionIds);

  if (status === 'active' && questionCoverage === 'none' && supportCoverage === 'none') {
    issues.push('uncovered branch');
  }
  if (questionCoverage === 'none' && supportCoverage !== 'none') {
    issues.push('fact-only coverage');
  }
  if (questionCoverage === 'weak') {
    issues.push('thin question coverage');
  }
  if (examCalibrationEvidence === 'yes' && questionCoverage === 'none') {
    issues.push('calibration evidence without question coverage');
  }
  if (missingLinks.length > 0) {
    issues.push('missing linked content');
  }

  return {
    familyId,
    branchId: branch.id,
    status,
    modifiers: branch.modifiers,
    questionCoverage,
    supportCoverage,
    examCalibrationEvidence,
    reviewExposure,
    issues,
    missingLinks,
  };
}

export function auditManagementCoverage(
  families: ManagementCoverageFamily[],
  inputs: ManagementCoverageAuditInputs
): ManagementCoverageAuditReport {
  const resolvedCalibrationLinks = new Set<string>();
  const familyReports: ManagementCoverageFamilyAudit[] = families.map((family) => ({
    id: family.id,
    title: family.title,
    rotation: family.rotation,
    branches: family.branches.map((branch) => auditBranch(family.id, branch, inputs, resolvedCalibrationLinks)),
  }));

  const allBranches = familyReports.flatMap((family) => family.branches);
  const unmodeledCalibrationLinks = inputs.calibrationLinkIds
    ? Array.from(inputs.calibrationLinkIds).filter((link) => !resolvedCalibrationLinks.has(link)).sort()
    : [];

  return {
    families: familyReports,
    summary: {
      families: familyReports.length,
      branches: allBranches.length,
      uncoveredBranches: allBranches.filter((branch) => branch.issues.includes('uncovered branch')).length,
      weakQuestionCoverageBranches: allBranches.filter((branch) => branch.questionCoverage === 'weak').length,
      factOnlyBranches: allBranches.filter((branch) => branch.issues.includes('fact-only coverage')).length,
      calibrationWithoutQuestionCoverage: allBranches.filter((branch) =>
        branch.issues.includes('calibration evidence without question coverage')
      ).length,
      noReviewExposureBranches: allBranches.filter(
        (branch) => branch.reviewExposure === 'no' && branch.questionCoverage !== 'none'
      ).length,
      missingLinks: allBranches.reduce((sum, branch) => sum + branch.missingLinks.length, 0),
      unmodeledCalibrationLinks: unmodeledCalibrationLinks.length,
    },
    unmodeledCalibrationLinks,
  };
}
