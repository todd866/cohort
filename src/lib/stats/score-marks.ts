/** Shared dumbbell grammar. Positions are fractions of the axis, 0–1. */
export const MARK_MERGE = 0.08;
export type MarkKind = 'you' | 'cohort' | 'ring';

export interface PlacedMark {
  at: number;
  kinds: MarkKind[];
}

/** Dots closer than MARK_MERGE become one marker so they cannot hide each other. */
export function placeMarks(marks: readonly { at: number; kind: MarkKind }[]): PlacedMark[] {
  const sorted = marks
    .filter((mark) => Number.isFinite(mark.at))
    .map((mark) => ({ at: Math.max(0, Math.min(1, mark.at)), kind: mark.kind }))
    .sort((a, b) => a.at - b.at);
  const groups: PlacedMark[] = [];
  for (const mark of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.at - mark.at) < MARK_MERGE) {
      last.at = (last.at * last.kinds.length + mark.at) / (last.kinds.length + 1);
      if (!last.kinds.includes(mark.kind)) last.kinds.push(mark.kind);
    } else {
      groups.push({ at: mark.at, kinds: [mark.kind] });
    }
  }
  return groups;
}
