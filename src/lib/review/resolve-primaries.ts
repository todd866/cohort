import { defaultPrimaryRotation } from '@/lib/institution-rotations';
import { scheduledObjectiveForModule } from './normalize-objective-modules';

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
 * enrolled in surgical-sciences + neurosurg + anatomy, and entitled to all
 * three, accumulated 2,162 ServeDecisions that were 100% CAH and not one item
 * from the decks they chose (found 2026-09-15). They were exposed to 20 items,
 * graded none, and left. Nothing looked broken from the inside: the feed was
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
