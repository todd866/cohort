import type { Institution } from '@/lib/institution';
import { personalDeckSlugs } from '@/lib/personal-decks';

const PERSONAL = personalDeckSlugs();

export const SCHEDULED_ROTATIONS: Record<Institution, string[]> = {
  usyd: [],
  'usyd-md1': [],
  'usyd-md2': [],
  usmle: ['usmle-step1'],
  other: [],
};

export const ALL_ROTATIONS: Record<Institution, string[]> = {
  ...SCHEDULED_ROTATIONS,
  usyd: [...PERSONAL],
  other: [...PERSONAL],
};

export function unreachableRotations(
  available: readonly string[],
  byInstitution: Record<string, string[]> = ALL_ROTATIONS,
): string[] {
  const reachable = new Set(Object.values(byInstitution).flat());
  return available.filter((rotation) => !reachable.has(rotation));
}
