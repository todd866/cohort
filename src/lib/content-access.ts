import type { CommitmentLevel } from './commitment';

export interface ContentAccess {
  videos: 'approved-only' | 'all';
  questionBank: boolean;
  curatedContent: boolean;       // Instagram reposts, video compilations
  institutionContent: boolean;   // institution-specific / textbook takes
  examContent: boolean;          // Practice KATs, exam simulations
  maxDifficulty: 'easy' | 'medium' | 'hard';
}

export function getContentAccess(level: CommitmentLevel): ContentAccess {
  switch (level) {
    case 'superfan':
      return {
        videos: 'all',
        questionBank: true,
        curatedContent: true,
        institutionContent: true,
        examContent: true,
        maxDifficulty: 'hard',
      };
    case 'committed':
      return {
        videos: 'all',
        questionBank: true,
        curatedContent: true,
        institutionContent: true,
        examContent: false,
        maxDifficulty: 'hard',
      };
    case 'student':
      return {
        videos: 'approved-only',
        questionBank: true,
        curatedContent: false,
        institutionContent: false,
        examContent: false,
        maxDifficulty: 'hard',
      };
    case 'browser':
      return {
        videos: 'approved-only',
        questionBank: false,
        curatedContent: false,
        institutionContent: false,
        examContent: false,
        maxDifficulty: 'medium',
      };
    case 'visitor':
    default:
      return {
        videos: 'approved-only',
        questionBank: false,
        curatedContent: false,
        institutionContent: false,
        examContent: false,
        maxDifficulty: 'easy',
      };
  }
}

const TIER_RANK: Record<CommitmentLevel, number> = {
  visitor: 0,
  browser: 1,
  student: 2,
  committed: 3,
  superfan: 4,
};

/** Check if a user's tier meets the required tier for a piece of content */
export function meetsRequiredTier(userTier: CommitmentLevel, requiredTier: string): boolean {
  const userRank = TIER_RANK[userTier];
  const requiredRank = TIER_RANK[requiredTier as CommitmentLevel];
  if (userRank === undefined || requiredRank === undefined) return false;
  return userRank >= requiredRank;
}

/** Map maxDifficulty to the Prisma filter array for card queries */
export function difficultyFilter(maxDifficulty: 'easy' | 'medium' | 'hard'): string[] {
  switch (maxDifficulty) {
    case 'easy': return ['easy'];
    case 'medium': return ['easy', 'medium'];
    case 'hard': return ['easy', 'medium', 'hard'];
  }
}
