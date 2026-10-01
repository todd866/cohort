import { defaultPrimaryRotation } from '@/lib/institution-rotations';
import { scheduledObjectiveForModule } from './normalize-objective-modules';
import { inPlayStudyRotations } from '@/lib/study/in-play-rotations';

/**
 * Resolve the default rotation list for a review session.
 *
 * Personal/opt-in decks are deliberately impossible to infer here: callers
 * pass only their institution's scheduled rotations. Those decks remain
 * reachable through the separately validated focus selector.
 */
export function resolvePrimaries(args: {
  activeModules: string[];
  activeRotations: string[];
  scheduledRotations: string[];
}): string[] {
  const scheduled = new Set(args.scheduledRotations);
  const calendarRotation = args.activeRotations.find((slug) => scheduled.has(slug));
  if (calendarRotation) return [calendarRotation];

  const moduleRotation = args.scheduledRotations.find((rotation) =>
    args.activeModules.some((moduleId) =>
      scheduledObjectiveForModule(moduleId, args.scheduledRotations) === rotation
    )
  );
  if (moduleRotation) return [moduleRotation];
  // No enrolment signal at all (guest, skipped onboarding, empty modules):
  // return empty and let the caller own the default. Manufacturing
  // scheduledRotations[0] here silently dropped every new visitor into
  // critical-care and made the no-enrolment chooser unreachable (2026-08-21).
  return [];
}

/**
 * The rotation a default review session opens on.
 *
 * `resolvePrimaries` returns `[]` for two situations that its own contract
 * describes as one. The first is a viewer with NO enrolment signal — a guest,
 * a skipped onboarding, empty modules — which is what the acquisition default
 * was written for. The second is a viewer who IS enrolled, but only in
 * rotations their institution does not schedule: the self-paced decks (GSSE,
 * NSx, anatomy) carry no exam date and so never appear in SCHEDULED_ROTATIONS.
 *
 * Collapsing those two into `DEFAULT_ONBOARDING_ROTATION` is how a learner
 * enrolled only in self-paced decks was served the default rotation and not one
 * item from the decks they chose. Nothing looked broken from the inside: the feed was
 * healthy, it was simply somebody else's feed.
 *
 * Preferring the enrolment cannot offer something the session service will then
 * refuse. `enrolledStudyable` derives from `activeModules` as delivered to the
 * client, and both `/api/modules/active` and `/api/user/minimal` drop any
 * personal deck the viewer may not read (`viewerCanAccessPersonalRotation`)
 * before it leaves the server. An unentitled deck is absent, not silent.
 */
export function defaultPrimaryForViewer(args: {
  primaries: readonly string[];
  enrolledStudyable: readonly string[];
  scheduledRotations: readonly string[];
}): string {
  return args.primaries[0]
    ?? args.enrolledStudyable[0]
    ?? defaultPrimaryRotation(args.scheduledRotations);
}

/** A practice paper's rotation, from the path a visitor first landed on. */
export function predictedRotationFromLanding(landingPath: string | null | undefined): string | null {
  const match = landingPath?.match(/^\/practice-exam\/([a-z0-9-]+)(?:\/|$)/);
  return match ? match[1] : null;
}

/**
 * The deck a viewer opens on. Only REAL enrolments (activeModules) count: the
 * review menu lists decks anyone may open, public Step 1 first, and passing it
 * here served every new guest Step 1 (2026-10-01). With no enrolment, start on
 * the rotation whose practice paper brought them here, then the acquisition
 * default.
 */
export function resolveViewerPrimary(args: {
  activeModules: string[];
  activeRotations: string[];
  scheduledRotations: string[];
  predicted?: string | null;
}): string {
  const primaries = resolvePrimaries(args);
  const enrolled = inPlayStudyRotations(args.activeModules);
  const predicted = args.predicted && args.scheduledRotations.includes(args.predicted) ? [args.predicted] : [];
  return defaultPrimaryForViewer({
    primaries,
    enrolledStudyable: enrolled.length ? enrolled : predicted,
    scheduledRotations: args.scheduledRotations,
  });
}
