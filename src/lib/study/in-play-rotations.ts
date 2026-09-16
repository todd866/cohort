import { ROTATION_LABELS } from '@/lib/rotation-labels';
import { SUPPLEMENTARY_ROTATION_IDS } from '@/lib/supplementary-rotations';
import { OBJECTIVE_MODULE_ALIASES } from '@/lib/review/normalize-objective-modules';

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
  const out: string[] = [];
  const seen = new Set<string>();
  for (const slug of activeModules) {
    // A module slug may be the rotation itself, an alias for it ('cc'), or a
    // subrotation beneath either ('cc/em'). Resolving all three matters: a CC
    // student's activeModules contain no literal 'critical-care' at all, so a
    // raw slug match returned [] and left the focus selector empty for them.
    const rotation = canonicalRotation(slug);
    if (!rotation || seen.has(rotation)) continue;
    seen.add(rotation);
    out.push(rotation);
  }
  return out;
}

function canonicalRotation(moduleSlug: string): string | null {
  if (STUDYABLE.has(moduleSlug)) return moduleSlug;
  for (const [rotation, aliases] of Object.entries(OBJECTIVE_MODULE_ALIASES)) {
    if (!STUDYABLE.has(rotation)) continue;
    for (const alias of aliases) {
      if (moduleSlug === alias || moduleSlug.startsWith(`${alias}/`)) return rotation;
    }
    if (moduleSlug.startsWith(`${rotation}/`)) return rotation;
  }
  return null;
}

// From the dependency-free leaf, NOT '@/lib/rotations': that module pulls in
// Prisma via getExamDateForUser, and this one is reachable from the client
// bundle (review-page-client), so importing it there fails the build outright.
// This used to be a hand-copied literal guarded by a drift test; the leaf makes
// the copy unnecessary — same reason session-candidate-scope.ts uses it.
const SUPPLEMENTARY = new Set<string>(SUPPLEMENTARY_ROTATION_IDS);

/**
 * The user's opted-in supplementary decks — cross-rotation content that
 * supports whatever block is running instead of having an exam of its own.
 *
 * These are invisible to `resolvePrimaries`, which only ever returns the
 * institution's scheduled rotations, so they need their own small slice of the
 * batch. Opting in is still explicit: a deck appears here only because it is
 * in the user's activeModules.
 */
export function activeSupplementaryRotations(activeModules: string[]): string[] {
  return activeModules.filter((slug) => SUPPLEMENTARY.has(slug));
}
