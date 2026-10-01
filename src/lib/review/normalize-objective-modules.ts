/**
 * Rotation slug -> the ModuleNode slugs that mean the same rotation.
 *
 * The ModuleNode taxonomy names Critical Care `cc` (with `cc/em`, `cc/icu`,
 * `cc/anaes` beneath it) while the content rotation slug is `critical-care`.
 * Every other rotation's module slug matches its content slug, which is why
 * this one mismatch is easy to miss.
 *
 * Exported because BOTH halves of the enrolment read need it: `resolvePrimaries`
 * (which rotation is primary) and `inPlayStudyRotations` (which rotations the
 * focus selector may offer). Only the first honoured it until 2026-08-23.
 */
export const OBJECTIVE_MODULE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'critical-care': ['cc'],
};

export function scheduledObjectiveForModule(
  moduleId: string,
  scheduledRotations: readonly string[],
): string | null {
  return scheduledRotations.find((rotation) => {
    const roots = [rotation, ...(OBJECTIVE_MODULE_ALIASES[rotation] ?? [])];
    return roots.some((root) =>
      moduleId === root || moduleId.startsWith(`${root}/`)
    );
  }) ?? null;
}
