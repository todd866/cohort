import { type Institution } from '@/lib/institution';
import { USYD_ROTATION_IDS } from '@/lib/rotations';

export type Jurisdiction = 'nsw' | 'wa' | 'national' | 'international';

const USYD_ROTATIONS = new Set(USYD_ROTATION_IDS);

export function getInstitutionFromRotation(rotation?: string | null): Institution | null {
  if (!rotation) return null;
  if (rotation.startsWith('usmle-')) return 'usmle';
  if (USYD_ROTATIONS.has(rotation)) return 'usyd';
  return null;
}

function getJurisdictionForInstitution(
  institution?: Institution | null
): Jurisdiction {
  if (!institution) return 'national';
  if (institution === 'usyd') return 'nsw';
  if (institution === 'usmle') return 'international';
  return 'national';
}

export function getJurisdictionForRotation(rotation?: string | null): Jurisdiction {
  return getJurisdictionForInstitution(getInstitutionFromRotation(rotation));
}

export function getRotationFromPath(path?: string | null): string | null {
  if (!path) return null;
  const match = path.match(/^\/([\w-]+)\/week\/\d+/);
  if (match) return match[1];
  const rootMatch = path.match(/^\/([\w-]+)(?:\/|$)/);
  if (rootMatch && USYD_ROTATIONS.has(rootMatch[1])) return rootMatch[1];
  if (rootMatch && rootMatch[1]?.startsWith('usmle-')) return rootMatch[1];
  return null;
}
