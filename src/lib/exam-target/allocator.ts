import type { ExamTargetInfluencePolicy } from './types';

export type ExamTargetSlotClass =
  | 'protected_due'
  | 'protected_relearn'
  | 'protected_failure'
  | 'protected_scaffold'
  | 'discretionary';

export interface ExamTargetCandidate {
  itemKey: string;
  slotClass: ExamTargetSlotClass;
  domainCode: string | null;
  /** Zero-based control rank inside the candidate's pedagogical stratum. */
  baseRank: number;
  itemTargetIndex: number | null;
}

export interface ExamTargetAllocationInput<T extends ExamTargetCandidate> {
  requestedSize: number;
  candidates: readonly T[];
  desiredShares: ReadonlyMap<string, number>;
  observedDomainCounts: ReadonlyMap<string, number>;
  influence: ExamTargetInfluencePolicy;
}

export interface ExamTargetAllocationResult<T extends ExamTargetCandidate> {
  selected: T[];
  controlSelected: T[];
  changedMembershipCount: number;
  coverageDebtDomainCodes: string[];
}

function targetAdjustedRank(
  candidate: ExamTargetCandidate,
  maxItemRankMove: number,
): number {
  const score = candidate.itemTargetIndex == null || !Number.isFinite(candidate.itemTargetIndex)
    ? 0
    : Math.min(1, Math.max(0, candidate.itemTargetIndex));
  return candidate.baseRank - maxItemRankMove * score;
}

function byControlRank<T extends ExamTargetCandidate>(a: T, b: T): number {
  return a.baseRank - b.baseRank || a.itemKey.localeCompare(b.itemKey);
}

function byTargetRank<T extends ExamTargetCandidate>(
  maxItemRankMove: number,
): (a: T, b: T) => number {
  return (a, b) =>
    targetAdjustedRank(a, maxItemRankMove)
    - targetAdjustedRank(b, maxItemRankMove)
    || byControlRank(a, b);
}

function membershipDelta<T extends ExamTargetCandidate>(control: readonly T[], target: readonly T[]): number {
  const controlKeys = new Set(control.map((candidate) => candidate.itemKey));
  return target.reduce(
    (count, candidate) => count + (controlKeys.has(candidate.itemKey) ? 0 : 1),
    0,
  );
}

export function allocateExamTargetSeats<T extends ExamTargetCandidate>(
  input: ExamTargetAllocationInput<T>,
): ExamTargetAllocationResult<T> {
  const requestedSize = Math.max(0, Math.floor(input.requestedSize));
  const protectedCandidates = input.candidates
    .filter((candidate) => candidate.slotClass !== 'discretionary')
    .sort(byControlRank)
    .slice(0, requestedSize);
  const openSeats = Math.max(0, requestedSize - protectedCandidates.length);
  const discretionaryCandidates = input.candidates
    .filter((candidate) => candidate.slotClass === 'discretionary')
    .sort(byControlRank);
  const controlDiscretionary = discretionaryCandidates.slice(0, openSeats);
  const controlSelected = [...protectedCandidates, ...controlDiscretionary];

  if (openSeats === 0 || input.influence.allocator === 'shadow') {
    return {
      selected: controlSelected,
      controlSelected,
      changedMembershipCount: 0,
      coverageDebtDomainCodes: [],
    };
  }

  const maxItemRankMove = Math.min(
    5,
    Math.max(0, Math.floor(input.influence.maxItemRankMove)),
  );
  if (input.influence.allocator === 'soft') {
    const targeted = [...discretionaryCandidates]
      .sort(byTargetRank(maxItemRankMove))
      .slice(0, openSeats);
    const selected = [...protectedCandidates, ...targeted];
    return {
      selected,
      controlSelected,
      changedMembershipCount: membershipDelta(controlSelected, selected),
      coverageDebtDomainCodes: [],
    };
  }

  const remaining = [...discretionaryCandidates];
  const selectedDiscretionary: T[] = [];
  const counts = new Map(input.observedDomainCounts);
  const observedTotal = [...counts.values()].reduce(
    (sum, value) => sum + Math.max(0, value),
    0,
  );
  const nextWindowSize = observedTotal + openSeats;
  const debt = new Set<string>();

  for (const domainCode of input.desiredShares.keys()) {
    if (!remaining.some((candidate) => candidate.domainCode === domainCode)) {
      debt.add(domainCode);
    }
  }

  while (selectedDiscretionary.length < openSeats && remaining.length > 0) {
    const feasibleDomains = [...input.desiredShares.keys()].filter(
      (domainCode) => remaining.some((candidate) => candidate.domainCode === domainCode),
    );
    let chosen: T | undefined;

    if (feasibleDomains.length > 0) {
      feasibleDomains.sort((left, right) => {
        const leftDeficit =
          (input.desiredShares.get(left) ?? 0) * nextWindowSize
          - (counts.get(left) ?? 0);
        const rightDeficit =
          (input.desiredShares.get(right) ?? 0) * nextWindowSize
          - (counts.get(right) ?? 0);
        return rightDeficit - leftDeficit || left.localeCompare(right);
      });
      const chosenDomain = feasibleDomains[0];
      chosen = remaining
        .filter((candidate) => candidate.domainCode === chosenDomain)
        .sort(byTargetRank(maxItemRankMove))[0];
    }

    // Neutral/unmapped candidates are a fill fallback, never evidence that a
    // missing target domain was covered.
    chosen ??= [...remaining].sort(byControlRank)[0];
    if (!chosen) break;
    selectedDiscretionary.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
    if (chosen.domainCode) {
      counts.set(chosen.domainCode, (counts.get(chosen.domainCode) ?? 0) + 1);
    }
  }

  const selected = [...protectedCandidates, ...selectedDiscretionary];
  return {
    selected,
    controlSelected,
    changedMembershipCount: membershipDelta(controlSelected, selected),
    coverageDebtDomainCodes: [...debt].sort(),
  };
}
