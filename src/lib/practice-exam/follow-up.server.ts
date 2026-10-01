import type { Prisma } from '@prisma/client';

/** Private practice-exam delivery is omitted from the public build. */
export const FOLLOW_UP_DELIVERY_SCHEMA = 'md3-practice-exam-follow-up/v1';
export function followUpItemFingerprint(_item: unknown): string { return ''; }
export function currentSource(_entry: unknown): { item: unknown } | null { return null; }
export async function ownsOriginalMiss(_prisma: unknown, _userId: string, _entry: unknown, _item: unknown): Promise<boolean> { return false; }
export async function claimPracticeExamFollowUps(_tx: Prisma.TransactionClient, _userId: string, _feedProfile: unknown): Promise<void> {}
