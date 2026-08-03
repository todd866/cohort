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
  const moduleRotations = [...new Set(args.activeModules.filter((slug) => scheduled.has(slug)))];
  if (moduleRotations.length > 1) return moduleRotations;

  const calendarRotations = [
    ...new Set(args.activeRotations.filter((slug) => scheduled.has(slug))),
  ];
  if (calendarRotations.length > 0) return calendarRotations;
  if (moduleRotations.length === 1) return moduleRotations;
  return args.scheduledRotations.length > 0 ? [args.scheduledRotations[0]] : [];
}
