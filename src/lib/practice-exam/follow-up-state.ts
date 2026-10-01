export const FOLLOW_UP_SCHEMA = 'practice-exam-follow-up/v1' as const;
export type FollowUpPhase = 'retest' | 'scaffold-needed' | 'deferred' | 'resolved';
export type FollowUpOutcome = 'correct' | 'wrong' | 'skip';
export interface FollowUpEntry { key: string; rotation: string; paperId: string; paperVersion: string; itemId: string; itemFingerprint: string; attemptId: string; questionNumber: number; paperTitle: string; paperPath: string; sourceSubmittedAt: string; phase: FollowUpPhase; revision: number; updatedAt: string; expiresAt: string; availableAfter: string; deliveryId?: string; }
export interface FollowUpState { schema: typeof FOLLOW_UP_SCHEMA; entries: FollowUpEntry[]; legacyInitializedRotations?: string[]; }
