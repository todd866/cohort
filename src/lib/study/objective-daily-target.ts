import type { RotationDailyTarget } from './rotation-daily-target';

/** Keep the caller's first requested rotation as the progress objective. */
export function selectObjectiveRow(
  rows: readonly RotationDailyTarget[],
  requestedRotations: readonly string[],
): RotationDailyTarget | null {
  const objective = requestedRotations[0];
  if (!objective) return null;
  return rows.find((row) => row.rotation === objective) ?? null;
}
