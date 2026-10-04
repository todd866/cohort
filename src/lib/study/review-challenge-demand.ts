/**
 * Records a real authoring demand when a learner asks for harder review
 * material but the eligible unseen hard pool is too small.
 *
 * This deliberately uses the existing ContentIssue queue. A challenge-demand
 * issue is structured telemetry, not a defect on a particular question; the
 * morning-check worklist aggregates it before asking authors to act.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';

export const REVIEW_CHALLENGE_DEMAND_ISSUE_TYPE = 'review-challenge-demand';
export const REVIEW_CHALLENGE_DEMAND_VERSION = 'review-challenge-demand-v1';
export const DEFAULT_REVIEW_CHALLENGE_RUNWAY = 15;

export type ReviewChallengeDemandStore = {
  contentIssue: {
    upsert(args: {
      where: { clientRequestId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

export interface ReviewChallengeDemandInput {
  userId: string;
  rotation: string;
  challengeLevel: number;
  knownGapConceptIds: string[];
  reason: string;
  /** Count returned by the real eligibility query, not a cache miss. */
  eligibleHardUnseenCount: number;
  /** Minimum hard/unseen runway desired by the caller. */
  minimumRequiredRunway?: number;
  now?: Date;
}

export interface ReviewChallengeDemandResult {
  recorded: number;
  skipped: number;
  issueKeys: string[];
}

function learnerKey(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function stableIssueKey(input: ReviewChallengeDemandInput, conceptId: string, now: Date): string {
  return [
    REVIEW_CHALLENGE_DEMAND_VERSION,
    dayKey(now),
    learnerKey(input.userId),
    input.rotation,
    conceptId,
  ].join(':');
}

function validate(input: ReviewChallengeDemandInput): void {
  if (!input.userId.trim() || !input.rotation.trim()) throw new Error('review challenge demand needs userId and rotation');
  if (!Number.isInteger(input.challengeLevel) || input.challengeLevel <= 0 || input.challengeLevel > 2) {
    throw new Error('review challenge demand only records positive levels 1 or 2');
  }
  if (!Number.isInteger(input.eligibleHardUnseenCount) || input.eligibleHardUnseenCount < 0) {
    throw new Error('eligibleHardUnseenCount must be a non-negative integer from a successful eligibility query');
  }
  const runway = input.minimumRequiredRunway ?? DEFAULT_REVIEW_CHALLENGE_RUNWAY;
  if (!Number.isInteger(runway) || runway < 1) throw new Error('minimumRequiredRunway must be a positive integer');
  if (input.eligibleHardUnseenCount >= runway) {
    throw new Error('demand must only be recorded when hard/unseen supply is below the required runway');
  }
}

/**
 * Fire after a response. The caller must supply the count from the same
 * successful hard/unseen eligibility query used by serving; query failures
 * therefore cannot be mis-recorded as zero supply.
 */
export async function recordReviewChallengeDemand(
  input: ReviewChallengeDemandInput,
  store: ReviewChallengeDemandStore = prisma as unknown as ReviewChallengeDemandStore,
): Promise<ReviewChallengeDemandResult> {
  validate(input);
  const now = input.now ?? new Date();
  const concepts = [...new Set(input.knownGapConceptIds.map((id) => id.trim()).filter(Boolean))];
  if (concepts.length === 0) return { recorded: 0, skipped: 1, issueKeys: [] };

  const minimumRequiredRunway = input.minimumRequiredRunway ?? DEFAULT_REVIEW_CHALLENGE_RUNWAY;
  const issueKeys: string[] = [];
  for (const conceptId of concepts) {
    const clientRequestId = stableIssueKey(input, conceptId, now);
    const metadata = {
      version: REVIEW_CHALLENGE_DEMAND_VERSION,
      learnerKey: learnerKey(input.userId),
      challengeLevel: input.challengeLevel,
      eligibleHardUnseenCount: input.eligibleHardUnseenCount,
      minimumRequiredRunway,
      deficit: minimumRequiredRunway - input.eligibleHardUnseenCount,
      reason: input.reason,
      conceptId,
      observedOn: dayKey(now),
    };
    await store.contentIssue.upsert({
      where: { clientRequestId },
      create: {
        clientRequestId,
        targetType: 'rotation',
        targetId: `review-challenge:${input.rotation}:${conceptId}`,
        issueType: REVIEW_CHALLENGE_DEMAND_ISSUE_TYPE,
        status: 'open',
        priority: input.challengeLevel >= 2 ? 'high' : 'normal',
        metadata,
        reportTrustState: 'structured',
        rotation: input.rotation,
      },
      update: { metadata, status: 'open', rotation: input.rotation },
    });
    issueKeys.push(clientRequestId);
  }
  return { recorded: issueKeys.length, skipped: 0, issueKeys };
}
