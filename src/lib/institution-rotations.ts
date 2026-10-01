import type { Institution } from '@/lib/institution';
import { personalDeckSlugs } from '@/lib/personal-decks';

const PERSONAL = personalDeckSlugs();

export const SCHEDULED_ROTATIONS: Record<Institution, string[]> = {
  usyd: [],
  'usyd-md1': [],
  'usyd-md2': [],
  usmle: [],
  other: [],
};

export const REACHABLE_ROTATIONS: ReadonlySet<string> = new Set([
  ...Object.values(SCHEDULED_ROTATIONS).flat(),
  ...PERSONAL,
]);

/**
 * The rotation a no-signal user (guest, skipped onboarding) is served, given
 * their institution's schedule. Public builds schedule no curriculum of their
 * own, so this falls back to the open Step 1 lane; the private acquisition
 * default is deliberately not part of this distribution.
 */
export function defaultPrimaryRotation(scheduledRotations: readonly string[]): string {
  return scheduledRotations[0] ?? 'usmle-step1-open';
}

export function unreachableRotations(
  available: readonly string[],
  reachable: ReadonlySet<string> = REACHABLE_ROTATIONS,
): string[] {
  return available.filter((rotation) => !reachable.has(rotation));
}
