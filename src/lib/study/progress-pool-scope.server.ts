import 'server-only';

import { isComposedDeck } from '@/lib/personal-decks';
import { entitledExamCrossSourceRotations } from './cross-source-access.server';

export interface ProgressPoolEntitlementInput {
  targetRotation: string;
  isGuest: boolean;
  activeModules: readonly string[];
  emails: readonly (string | null | undefined)[];
  imageTier: 'standard' | 'copyright' | null;
}

/** Composed modules count their enrolled companions as the module itself.
 * Scheduled exam budgets retain the native core: optional later cross-source
 * seats must not inflate the workload used to unlock those same seats.
 */
export function resolveProgressCrossSourceRotations(
  input: ProgressPoolEntitlementInput,
): readonly string[] {
  if (!isComposedDeck(input.targetRotation)) return [];
  return entitledExamCrossSourceRotations({
    ...input,
    currentObjective: input.targetRotation,
    explicitFocus: true,
  });
}
