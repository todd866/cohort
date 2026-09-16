/**
 * Core Clinical Skills — Always-On Skill Retention
 *
 * Core skills (ECG, radiology, ABG, etc.) are foundational across all years
 * and institutions. They get capped review intervals and are mixed into
 * every rotation's study queue.
 *
 * See docs/designs/2026-03-01-core-clinical-skills.md
 */

import { UNIVERSAL_MODULES } from './institution';

/**
 * Get the stability cap (max interval in days) for a card based on its rotation.
 * Returns undefined if the rotation is not a core skill rotation.
 */
export function getCoreSkillCap(rotation: string): number | undefined {
  // Find the first module whose contentRotations includes this rotation
  for (const mod of UNIVERSAL_MODULES) {
    if (mod.contentRotations?.includes(rotation) && mod.maxIntervalDays) {
      return mod.maxIntervalDays;
    }
  }
  return undefined;
}

/**
 * Get all rotation IDs that contain core skill content for the given enabled modules.
 * Deduplicated — multiple modules may share the same rotation.
 */
export function getCoreSkillRotations(enabledModules: string[]): string[] {
  const rotations = new Set<string>();
  for (const mod of UNIVERSAL_MODULES) {
    if (enabledModules.includes(mod.id) && mod.contentRotations) {
      for (const r of mod.contentRotations) {
        rotations.add(r);
      }
    }
  }
  return [...rotations];
}
