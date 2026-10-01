export const RESOLVABLE_ISSUE_STATUSES = ['open', 'in-progress'] as const;

export interface ResolutionIssue {
  id: string;
  status: string;
  targetType: string;
  targetId: string;
  metadata: unknown;
}

export interface SkippedResolutionId {
  id: string;
  reason: 'not-found' | 'already-closed';
  status?: string;
}

export interface UserCardFlagTarget {
  cardId: string;
  userId: string;
}

export function isResolvableIssueStatus(status: string): boolean {
  return (RESOLVABLE_ISSUE_STATUSES as readonly string[]).includes(status);
}

export function isUserReportedIssue(metadata: unknown): boolean {
  return isRecord(metadata) && metadata.reporterType === 'user';
}

/**
 * Keep explicit-ID resolution monotonic: terminal rows are reported as skipped
 * and never become candidates for an update that could replace their original
 * resolution timestamp or attribution.
 */
export function partitionRequestedIssues(
  requestedIds: string[],
  rows: ResolutionIssue[],
): { resolvable: ResolutionIssue[]; skipped: SkippedResolutionId[] } {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const resolvable: ResolutionIssue[] = [];
  const skipped: SkippedResolutionId[] = [];

  for (const id of requestedIds) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'not-found' });
    } else if (!isResolvableIssueStatus(row.status)) {
      skipped.push({ id, reason: 'already-closed', status: row.status });
    } else {
      resolvable.push(row);
    }
  }

  return { resolvable, skipped };
}

/** Return the exact progress owner represented by a structured user card issue. */
export function userCardFlagTarget(issue: ResolutionIssue): UserCardFlagTarget | null {
  if (issue.targetType !== 'card' || !isRecord(issue.metadata)) return null;
  if (issue.metadata.reporterType !== 'user') return null;

  const userId = issue.metadata.userId;
  if (typeof userId !== 'string' || userId.trim() === '') return null;

  return { cardId: issue.targetId, userId };
}

/**
 * Select progress rows safe to clear after a set of issues was resolved.
 * A second open/in-progress issue from the same user for the same card keeps
 * that user's live flag in place.
 */
export function selectUserCardFlagsToClear(
  resolvedIssues: ResolutionIssue[],
  remainingIssues: ResolutionIssue[],
): UserCardFlagTarget[] {
  const blocked = new Set(
    remainingIssues
      .filter((issue) => isResolvableIssueStatus(issue.status))
      .map(userCardFlagTarget)
      .filter((target): target is UserCardFlagTarget => target !== null)
      .map(flagTargetKey),
  );
  const seen = new Set<string>();
  const clear: UserCardFlagTarget[] = [];

  for (const issue of resolvedIssues) {
    const target = userCardFlagTarget(issue);
    if (!target) continue;
    const key = flagTargetKey(target);
    if (blocked.has(key) || seen.has(key)) continue;
    seen.add(key);
    clear.push(target);
  }

  return clear;
}

function flagTargetKey(target: UserCardFlagTarget): string {
  return JSON.stringify([target.cardId, target.userId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
