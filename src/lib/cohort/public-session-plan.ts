import { COHORT_HOOK_V1_IDS } from './hook-playlist';
import {
  allowedDifficulties,
  cohortCandidatePreference,
  type CohortCandidatePreference,
} from './experience-prior';
import type { CohortFeedProfile } from './feed-profile';
import type { DifficultyTier } from '@/lib/usmle/step1-adaptive';

export function publicSessionPlan(profile: CohortFeedProfile): {
  prependQuestionIds: string[];
  allowedDifficulties: DifficultyTier[];
  adaptiveCandidatePreference: CohortCandidatePreference | undefined;
  /** Cohort adapts between requests; private Review keeps its larger batches. */
  turnSize: number;
} {
  const needsHook = !profile.hookCompletedAt;
  return {
    prependQuestionIds: needsHook ? [...COHORT_HOOK_V1_IDS] : [],
    allowedDifficulties: allowedDifficulties(profile.explicit.experience),
    adaptiveCandidatePreference: cohortCandidatePreference(profile.explicit.experience),
    // The hook is one fixed, editorially reviewed three-item unit. Once it is
    // complete, every request is one item so the next request can observe the
    // grade that just landed and genuinely climb/hold/scaffold.
    turnSize: needsHook ? COHORT_HOOK_V1_IDS.length : 1,
  };
}
