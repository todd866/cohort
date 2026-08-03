import { ROTATION_LABELS } from '@/lib/rotation-labels';

// Every studyable rotation slug. Derived from ROTATION_LABELS (a committed,
// hand-maintained map) rather than the AUTO-GENERATED, gitignored
// `@/lib/generated/content-map-rotations` — that file is produced only by
// `npm run build`/`dev`, NOT by `pretest`, so importing it would break this
// unit test on a clean checkout. ROTATION_LABELS must list every loadable
// rotation (keep it in sync with the generated AVAILABLE_ROTATIONS).
const STUDYABLE = new Set<string>(Object.keys(ROTATION_LABELS));

/**
 * The user's enrolled, loadable rotations — `activeModules ∩ studyable slugs`.
 * Drops program/institution slugs (e.g. 'usyd-md3') that aren't content rotations.
 * Single source of truth for the explicit-focus selector. The normal blend is
 * resolved separately from SCHEDULED_ROTATIONS so personal decks remain opt-in.
 */
export function inPlayStudyRotations(activeModules: string[]): string[] {
  return activeModules.filter((slug) => STUDYABLE.has(slug));
}
