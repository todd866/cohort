export interface SeedReinforcementRefreshStats {
  attempted: number;
  refreshed: number;
  requiredRefreshed: number;
  /** Required questions that correctly ended with NO live qcard (ineligible → retired). */
  requiredRetired: number;
  optionalFailures: Array<{ questionId: string; error: unknown }>;
}

interface RefreshSeedReinforcementCardsOptions {
  questionIds: readonly string[];
  /** Media/role drift repairs are safety-critical and must complete. */
  requiredQuestionIds: readonly string[];
  refresh: (questionId: string) => Promise<unknown | null>;
  /**
   * Liveness probe consulted when a REQUIRED refresh returns null. The hazard
   * the required set guards is a live qcard retaining stale prompt/optional
   * semantics — but ensure() legitimately returns null for questions that must
   * NOT have a qcard (raw-public USMLE identity, cloze-ineligible drafts),
   * after retiring any stale card. If no live card remains, nothing stale can
   * be served and the repair has succeeded by retirement. Found 2026-08-26 when
   * 27 image-prompt questions aborted every broad seed. Omitting the probe
   * keeps the historical fail-closed behaviour.
   */
  hasLiveReinforcementCard?: (questionId: string) => Promise<boolean>;
  onOptionalFailure?: (questionId: string, error: unknown) => void;
}

/**
 * Refresh changed-question qcards while distinguishing optional content churn
 * from required media-role repair. A seed may warn and continue when an
 * unrelated changed question has no reinforcement card, but it must abort if a
 * current qcard could retain stale prompt/optional semantics.
 */
export async function refreshSeedReinforcementCards(
  options: RefreshSeedReinforcementCardsOptions,
): Promise<SeedReinforcementRefreshStats> {
  const required = new Set(options.requiredQuestionIds);
  const questionIds = [...new Set([
    ...options.questionIds,
    ...options.requiredQuestionIds,
  ])].sort();
  const optionalFailures: SeedReinforcementRefreshStats['optionalFailures'] = [];
  const requiredFailures: Array<{ questionId: string; error: unknown }> = [];
  let refreshed = 0;
  let requiredRefreshed = 0;
  let requiredRetired = 0;

  for (const questionId of questionIds) {
    try {
      const result = await options.refresh(questionId);
      if (result != null) {
        refreshed += 1;
        if (required.has(questionId)) requiredRefreshed += 1;
      } else if (required.has(questionId)) {
        const retiredClean = options.hasLiveReinforcementCard
          ? !(await options.hasLiveReinforcementCard(questionId))
          : false;
        if (retiredClean) {
          requiredRetired += 1;
        } else {
          requiredFailures.push({
            questionId,
            error: new Error('required reinforcement media repair returned no card'),
          });
        }
      }
    } catch (error) {
      if (required.has(questionId)) {
        requiredFailures.push({ questionId, error });
      } else {
        optionalFailures.push({ questionId, error });
        options.onOptionalFailure?.(questionId, error);
      }
    }
  }

  if (requiredFailures.length > 0) {
    const ids = requiredFailures.map((failure) => failure.questionId).join(', ');
    throw new Error(
      `Required reinforcement media repair failed for ${requiredFailures.length} question(s): ${ids}`,
      { cause: requiredFailures[0].error },
    );
  }

  return {
    attempted: questionIds.length,
    refreshed,
    requiredRefreshed,
    requiredRetired,
    optionalFailures,
  };
}
