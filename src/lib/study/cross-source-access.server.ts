import 'server-only';

import { EXAM_CROSS_SOURCE_ROTATION_IDS } from '@/lib/cross-source-rotations';
import { SCHEDULED_ROTATIONS } from '@/lib/institution-rotations';
import {
  isPersonalRotation,
  viewerCanAccessPersonalRotation,
} from '@/lib/personal-rotation-access';

export interface ExamCrossSourceAccessInput {
  targetRotation: string;
  currentObjective: string | null;
  isGuest: boolean;
  explicitFocus?: boolean;
  activeModules: readonly string[];
  emails: readonly (string | null | undefined)[];
  /**
   * The viewer's persisted image tier. Only companion pairing reads it, and it
   * must come from the user row: the cross-source list below deliberately
   * denies every shared-tier grant, so passing a tier cannot widen it.
   */
  imageTier?: 'standard' | 'copyright' | null;
}

const SCHEDULED_EXAM_ROTATIONS = new Set(
  Object.values(SCHEDULED_ROTATIONS).flat(),
);

/**
 * Decks that study alongside a declared companion source.
 *
 * Requested 2026-09-11: "make sure we blend bluelink atlas into this." The GSSE deck
 * is textbook plates and BlueLink is 4,747 cadaver-photo ID cards of the same
 * structures — two decks only because the pictures came from different places,
 * which is not a distinction a student studying anatomy cares about.
 *
 * A companion may ONLY be a supplementary rotation, and that is what makes this
 * safe where the cross-source list below is guarded so carefully: supplementary
 * content is opt-in for any signed-in user, so admitting it grants the viewer
 * nothing they could not already reach by enrolling in it directly. Enrolment
 * is still required, so the blend arrives because the user asked for it.
 *
 * Never add a personal deck here. Those are owner-gated, and a companion
 * pairing would be a way around the allow-list that protects them.
 */
const COMPANION_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // The three views of one anatomy corpus. Each draws the others' cards that
  // declare its own slug in moduleNodes, so a plate is authored once and can
  // appear under Anatomy, GSSE and NSx without being copied.
  'surgical-sciences': Object.freeze(['anatomy', 'neurosurg']),
  anatomy: Object.freeze(['surgical-sciences', 'neurosurg']),
  neurosurg: Object.freeze(['surgical-sciences', 'anatomy']),
});

function companionSources(input: ExamCrossSourceAccessInput): string[] {
  const declared = COMPANION_SOURCES[input.targetRotation];
  if (!declared) return [];

  // A deck the learner has explicitly focused IS their objective for this
  // session. Requiring targetRotation === currentObjective looked conservative
  // and was in fact fatal: currentObjective is the SCHEDULED block — 'cah' for a
  // Year-3 student — while the target is whatever they just chose in the
  // selector, so the two are equal only for the block they are already sitting.
  // A view with no native cards of its own is composed entirely of its
  // companions, so that condition made NSx permanently empty for everybody, and
  // the deck that does have native cards hid it by working anyway.
  //
  // Focus is what keeps this narrow: without it a target that is not the current
  // objective stays native-only, so a background blend can never widen itself.
  const chosen = input.explicitFocus || input.targetRotation === input.currentObjective;
  if (!chosen) return [];

  const enrolled = new Set(input.activeModules);
  return declared.filter((source) => {
    if (!enrolled.has(source)) return false;
    if (!isPersonalRotation(source)) return true;
    // A personal companion is admitted only when the viewer is independently
    // entitled to it. That is not an exception to the owner gate, it IS the
    // owner gate: a viewer who passes this could focus that deck directly, so
    // the pairing carries no access they did not already have.
    //
    // This is where companions diverge from the cross-source list below, which
    // passes imageTier: null to deny shared-tier decks outright. The difference
    // is consent, not trust — cross-source blending drops a deck into a
    // SCHEDULED exam session the user did not ask for, while a companion only
    // fires on a deck the user enrolled in and chose.
    return viewerCanAccessPersonalRotation(source, {
      emails: input.emails,
      imageTier: input.imageTier ?? null,
    });
  });
}

/**
 * Resolve the external content partitions that may contribute to one exam
 * session. Client parameters never grant this access: the caller supplies the
 * persisted user row, and personal sources additionally require the immutable
 * server owner allow-list.
 */
export function entitledExamCrossSourceRotations(
  input: ExamCrossSourceAccessInput,
): string[] {
  if (input.isGuest) return [];

  // A declared companion survives explicit focus, unlike the cross-source list
  // below. The prohibition there exists so that focusing one source deck cannot
  // become a bridge into other imported or private partitions; a supplementary
  // companion is neither, and a deck studied mainly BY focusing it would
  // otherwise never blend at all.
  const companions = companionSources(input);
  if (companions.length > 0) return companions;

  if (input.explicitFocus) return [];
  // Cross-source blending supports one scheduled exam objective. Explicit
  // focus on a source deck remains source-only; it must not become a bridge
  // into other imported/private partitions.
  if (
    !SCHEDULED_EXAM_ROTATIONS.has(input.targetRotation)
    || input.targetRotation !== input.currentObjective
  ) return [];

  const enrolled = new Set(input.activeModules);
  return EXAM_CROSS_SOURCE_ROTATION_IDS.filter((sourceRotation) => {
    if (sourceRotation === input.targetRotation) return false;
    if (!enrolled.has(sourceRotation)) return false;
    if (!isPersonalRotation(sourceRotation)) return true;
    // Cross-source blend decks are owner-only; imageTier null denies any
    // shared-tier grant here on purpose (none is declared for these decks).
    return viewerCanAccessPersonalRotation(sourceRotation, {
      emails: input.emails,
      imageTier: null,
    });
  });
}
