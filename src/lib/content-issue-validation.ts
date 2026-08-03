/**
 * Content Issue Resolution Validation
 *
 * Prevents rubber-stamping: when an agent resolves a ContentIssue for a fixable
 * issue type, we verify that the underlying card content actually changed.
 */

import { prisma } from '@/lib/prisma';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';

// Issue types that require actual content changes to resolve
export const FIXABLE_ISSUE_TYPES = [
  'formatting',
  'too-long',
  'tla',
  'confusing',
  'incorrect',
  'content-error',          // factual content error (variant of 'incorrect')
  'premortem-factual',      // factual defect found by the premortem harness
  'context',
  'incomplete-data',
  'systemic-card-context-too-long',
  'systemic-question-context-too-long',
] as const;

// Issue types that can be resolved without content changes
export const NON_FIXABLE_ISSUE_TYPES = [
  'needs-image',
  'too-easy',
  'outdated',
  'duplicate',
  'disagreement',           // auditor-vs-human triage decision, not a content edit
  'other',
] as const;

/** Classify an issueType. 'unknown' = registered in neither list (fails closed). */
export function classifyIssueType(issueType: string): 'fixable' | 'non-fixable' | 'unknown' {
  // `rule:<name>` is a dynamic family of detector flags — all require a content
  // fix to genuinely resolve, so the whole prefix is fixable.
  if (issueType.startsWith('rule:')) return 'fixable';
  if ((FIXABLE_ISSUE_TYPES as readonly string[]).includes(issueType)) return 'fixable';
  if ((NON_FIXABLE_ISSUE_TYPES as readonly string[]).includes(issueType)) return 'non-fixable';
  return 'unknown';
}

export interface ResolutionEvidence {
  beforeSnapshot: string | null;
  afterSnapshot: string | null;
  contentChanged: boolean;
  validatedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  evidence: ResolutionEvidence;
  reason?: string;
}

/**
 * Validate that a ContentIssue resolution is legitimate.
 *
 * For fixable issue types, compares the current card content against the
 * stored contentSnapshot. If content hasn't changed, the resolution is invalid.
 */
export async function validateResolution(issueId: string): Promise<ValidationResult> {
  const issue = await prisma.contentIssue.findUnique({
    where: { id: issueId },
  });

  if (!issue) {
    return {
      valid: false,
      evidence: { beforeSnapshot: null, afterSnapshot: null, contentChanged: false, validatedAt: new Date().toISOString() },
      reason: 'Issue not found',
    };
  }

  const klass = classifyIssueType(issue.issueType);

  // Fail CLOSED on an unregistered issueType. Previously these fell through the
  // `!isFixableType` branch and auto-resolved (valid:true) — a silent
  // rubber-stamp bypass for any typo'd or newly-introduced type. Register it in
  // FIXABLE_ISSUE_TYPES or NON_FIXABLE_ISSUE_TYPES instead.
  if (klass === 'unknown') {
    return {
      valid: false,
      evidence: {
        beforeSnapshot: issue.contentSnapshot,
        afterSnapshot: null,
        contentChanged: false,
        validatedAt: new Date().toISOString(),
      },
      reason: `Unregistered issueType '${issue.issueType}' — cannot auto-resolve. Add it to FIXABLE_ISSUE_TYPES or NON_FIXABLE_ISSUE_TYPES in content-issue-validation.ts.`,
    };
  }

  // Non-fixable types can always be resolved
  if (klass === 'non-fixable') {
    return {
      valid: true,
      evidence: {
        beforeSnapshot: issue.contentSnapshot,
        afterSnapshot: null,
        contentChanged: false,
        validatedAt: new Date().toISOString(),
      },
    };
  }

  // For card issues, check if content has changed
  if (issue.targetType === 'card') {
    const card = await prisma.card.findUnique({
      where: { id: issue.targetId },
      select: { id: true, front: true },
    });

    const deliverableCard = card
      ? (await filterDeliverableReinforcementCardRows([card], {
          logContext: { transport: 'content-issue-resolution' },
        }))[0]
      : null;
    if (!deliverableCard) {
      return {
        valid: false,
        evidence: { beforeSnapshot: issue.contentSnapshot, afterSnapshot: null, contentChanged: false, validatedAt: new Date().toISOString() },
        reason: 'Card not found — may have been deleted',
      };
    }

    const afterSnapshot = deliverableCard.front.slice(0, 200);
    const contentChanged = issue.contentSnapshot !== afterSnapshot;

    if (!contentChanged) {
      return {
        valid: false,
        evidence: { beforeSnapshot: issue.contentSnapshot, afterSnapshot, contentChanged: false, validatedAt: new Date().toISOString() },
        reason: `Content has not changed since the issue was reported. Fix the MDX source and re-seed before resolving.`,
      };
    }

    return {
      valid: true,
      evidence: { beforeSnapshot: issue.contentSnapshot, afterSnapshot, contentChanged: true, validatedAt: new Date().toISOString() },
    };
  }

  // For question issues, check question stem
  if (issue.targetType === 'question') {
    const question = await prisma.question.findUnique({
      where: { id: issue.targetId },
      select: { stem: true },
    });

    if (!question) {
      return {
        valid: false,
        evidence: { beforeSnapshot: issue.contentSnapshot, afterSnapshot: null, contentChanged: false, validatedAt: new Date().toISOString() },
        reason: 'Question not found — may have been deleted',
      };
    }

    const afterSnapshot = question.stem.slice(0, 200);
    const contentChanged = issue.contentSnapshot !== afterSnapshot;

    if (!contentChanged) {
      return {
        valid: false,
        evidence: { beforeSnapshot: issue.contentSnapshot, afterSnapshot, contentChanged: false, validatedAt: new Date().toISOString() },
        reason: `Content has not changed since the issue was reported. Fix the MDX source and re-seed before resolving.`,
      };
    }

    return {
      valid: true,
      evidence: { beforeSnapshot: issue.contentSnapshot, afterSnapshot, contentChanged: true, validatedAt: new Date().toISOString() },
    };
  }

  // For other target types (component, page), allow resolution
  return {
    valid: true,
    evidence: {
      beforeSnapshot: issue.contentSnapshot,
      afterSnapshot: null,
      contentChanged: false,
      validatedAt: new Date().toISOString(),
    },
  };
}
