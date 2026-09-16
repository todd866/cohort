import 'server-only';

/** Public build: private review-topic registrations are intentionally absent. */
export function authorizedReviewTopicRotations(
  _activeModules: readonly string[],
): Readonly<Record<string, string>> {
  void _activeModules;
  return {};
}

export function registeredReviewTopicRotation(_topic: string): string | undefined {
  void _topic;
  return undefined;
}
