/**
 * The learner's own "No exam follow-ups" switch.
 *
 * A learner who has already worked through their exam misses may want the rest
 * of the rotation instead. Follow-ups are paced through the ordinary feed
 * (`FOLLOW_UP_MIN_GAP_MS`); this switch stands them down entirely. The plans
 * are kept, so turning follow-ups back on resumes where the learner left off.
 *
 * Stored as `User.experience.practiceFollowUps` ('off' | 'on'), beside the other
 * learner-chosen review settings. Absent means on. Client-safe leaf.
 */
export type PracticeFollowUpsSetting = 'on' | 'off';

export function practiceFollowUpsOffFromExperience(experience: unknown): boolean {
  if (!experience || typeof experience !== 'object' || Array.isArray(experience)) return false;
  return (experience as Record<string, unknown>).practiceFollowUps === 'off';
}
