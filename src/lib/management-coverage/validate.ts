import type { ManagementCoverageBranch, ManagementCoverageFamily, ManagementCoverageLink } from './types';

const ALLOWED_STATUSES = new Set(['active', 'planned']);
const ALLOWED_LINK_KINDS = new Set(['question', 'mdx-section', 'card']);
const ALLOWED_LINK_STRENGTHS = new Set(['primary', 'supporting', 'adjacent']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateLink(link: ManagementCoverageLink, index: number): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(link.kind)) errors.push(`linkedContent[${index}].kind is required`);
  else if (!ALLOWED_LINK_KINDS.has(link.kind)) {
    errors.push(`linkedContent[${index}].kind must be one of ${Array.from(ALLOWED_LINK_KINDS).join(', ')}`);
  }
  if (!isNonEmptyString(link.id)) errors.push(`linkedContent[${index}].id is required`);
  if (!isNonEmptyString(link.strength)) errors.push(`linkedContent[${index}].strength is required`);
  else if (!ALLOWED_LINK_STRENGTHS.has(link.strength)) {
    errors.push(
      `linkedContent[${index}].strength must be one of ${Array.from(ALLOWED_LINK_STRENGTHS).join(', ')}`
    );
  }
  return errors;
}

function branchHasAnyLinks(branch: ManagementCoverageBranch): boolean {
  return (branch.linkedContent?.length ?? 0) > 0 || (branch.calibrationLinks?.length ?? 0) > 0;
}

export function validateManagementCoverageFamily(family: ManagementCoverageFamily): string[] {
  const errors: string[] = [];

  if (!isNonEmptyString(family.id)) errors.push('id is required');
  if (!isNonEmptyString(family.title)) errors.push('title is required');
  if (!isNonEmptyString(family.rotation)) errors.push('rotation is required');
  if (!isNonEmptyString(family.baseScenario)) errors.push('baseScenario is required');
  if (!isNonEmptyString(family.task)) errors.push('task is required');

  if (!Array.isArray(family.branches) || family.branches.length === 0) {
    errors.push('branches must be a non-empty array');
    return errors;
  }

  const branchIds = new Set<string>();

  for (let i = 0; i < family.branches.length; i++) {
    const branch = family.branches[i];
    const prefix = `branches[${i}]`;

    if (!isNonEmptyString(branch.id)) {
      errors.push(`${prefix}: id is required`);
    } else if (branchIds.has(branch.id)) {
      errors.push(`${prefix}: duplicate branch id "${branch.id}"`);
    } else {
      branchIds.add(branch.id);
    }

    if (!Array.isArray(branch.modifiers) || branch.modifiers.length === 0) {
      errors.push(`${prefix}: modifiers must be a non-empty array`);
    } else {
      const seenModifiers = new Set<string>();
      for (const modifier of branch.modifiers) {
        if (!isNonEmptyString(modifier)) {
          errors.push(`${prefix}: modifiers must not contain empty values`);
          continue;
        }
        if (seenModifiers.has(modifier)) {
          errors.push(`${prefix}: modifiers must be unique`);
          break;
        }
        seenModifiers.add(modifier);
      }
    }

    if (!isNonEmptyString(branch.rationale)) {
      errors.push(`${prefix}: rationale is required`);
    }

    if (branch.status && !ALLOWED_STATUSES.has(branch.status)) {
      errors.push(`${prefix}: status must be one of ${Array.from(ALLOWED_STATUSES).join(', ')}`);
    }

    const hasBestAction = isNonEmptyString(branch.expectedBestAction);
    const hasAvoidActions = Array.isArray(branch.expectedAvoidActions) && branch.expectedAvoidActions.some(isNonEmptyString);
    if (!hasBestAction && !hasAvoidActions) {
      errors.push(`${prefix}: expectedBestAction or expectedAvoidActions is required`);
    }

    if (Array.isArray(branch.expectedAvoidActions) && branch.expectedAvoidActions.some((value) => !isNonEmptyString(value))) {
      errors.push(`${prefix}: expectedAvoidActions must not contain empty values`);
    }

    if (Array.isArray(branch.linkedContent)) {
      for (let j = 0; j < branch.linkedContent.length; j++) {
        errors.push(...validateLink(branch.linkedContent[j]!, j).map((error) => `${prefix}: ${error}`));
      }
    }

    if (Array.isArray(branch.calibrationLinks)) {
      for (const calibrationLink of branch.calibrationLinks) {
        if (!isNonEmptyString(calibrationLink)) {
          errors.push(`${prefix}: calibrationLinks must not contain empty values`);
          break;
        }
      }
    }

    const status = branch.status ?? 'active';
    if (status !== 'planned' && !branchHasAnyLinks(branch)) {
      errors.push(`${prefix}: active branches must include linkedContent or calibrationLinks`);
    }
  }

  return errors;
}

export function validateManagementCoverageRegistry(families: ManagementCoverageFamily[]): string[] {
  const errors: string[] = [];
  const familyIds = new Set<string>();

  for (const family of families) {
    if (!isNonEmptyString(family.id)) continue;
    if (familyIds.has(family.id)) {
      errors.push(`duplicate family id "${family.id}"`);
      continue;
    }
    familyIds.add(family.id);
  }

  return errors;
}
