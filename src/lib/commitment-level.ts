export type CommitmentLevel = 'visitor' | 'browser' | 'student' | 'committed' | 'superfan';

export interface CommitmentProfile {
  totalReviews: number;   // Graded card-review events in the observation window
  totalMcqs: number;      // Graded MCQ-attempt events in the observation window
  distinctDays: number;   // Unique calendar days with grading activity
  returnedAfterGap: boolean; // Came back after a 2+ day gap
  accuracy: number | null;   // MCQ accuracy (null if no MCQ attempts)
}

export interface CommitmentResult extends CommitmentProfile {
  level: CommitmentLevel;
  totalActivity: number;
}

const STUDENT_MIN_ACTIVITY = 50;
const STUDENT_MIN_DAYS = 3;
const COMMITTED_MIN_ACTIVITY = 200;
const COMMITTED_MIN_DAYS = 7;
const SUPERFAN_MIN_ACTIVITY = 1000;
const SUPERFAN_MIN_DAYS = 90;

/** The default observation window must be able to contain every tier threshold. */
export const DEFAULT_COMMITMENT_WINDOW_DAYS = 120;

export function computeCommitmentLevel(profile: CommitmentProfile): CommitmentLevel {
  const totalActivity = profile.totalReviews + profile.totalMcqs;

  if (totalActivity === 0) return 'visitor';

  if (
    totalActivity >= SUPERFAN_MIN_ACTIVITY &&
    profile.distinctDays >= SUPERFAN_MIN_DAYS &&
    profile.returnedAfterGap
  ) {
    return 'superfan';
  }

  if (
    totalActivity >= COMMITTED_MIN_ACTIVITY &&
    profile.distinctDays >= COMMITTED_MIN_DAYS &&
    profile.returnedAfterGap
  ) {
    return 'committed';
  }

  if (
    totalActivity >= STUDENT_MIN_ACTIVITY &&
    profile.distinctDays >= STUDENT_MIN_DAYS
  ) {
    return 'student';
  }

  return 'browser';
}
