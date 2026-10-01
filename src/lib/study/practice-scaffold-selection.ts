import type { SessionContext } from './unified-session-types';

export interface PreparedPracticeScaffoldTarget {
  questionId: string;
}

export interface PreparedPracticeScaffoldCompletion {
  entryKey: string;
}

/** The private institution scaffold lane is absent from the public build. */
export function permitsPracticeFollowUp(_ctx: SessionContext): boolean {
  return false;
}

export function hasPracticeScaffoldWork(_ctx: SessionContext, _nowMs = Date.now()): boolean {
  return false;
}

export function prepareInstantPracticeScaffold(
  _ctx: SessionContext,
  _eligibleIds: ReadonlySet<string>,
  _familiarity: ReadonlyMap<string, unknown> | null,
  _nowMs = Date.now(),
): { targets: PreparedPracticeScaffoldTarget[]; completed: PreparedPracticeScaffoldCompletion[] } {
  return { targets: [], completed: [] };
}

export function choosePracticeScaffoldTarget(
  _targets: readonly PreparedPracticeScaffoldTarget[],
  _sessionId: string,
): PreparedPracticeScaffoldTarget | null {
  return null;
}
