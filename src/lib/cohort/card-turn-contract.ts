/**
 * The card half of the Cohort turn contract (docs/designs/2026-09-23-cohort-mirror.md,
 * Increment 3). Client-safe: the turn route, the replay parser and the review
 * client all read a card item through this one parser.
 *
 * A Cohort card is self-graded, so the answer travels with the prompt; the
 * client reveals it locally. What stays server-side is the card's identity:
 * the client sees only the delivery id it grades against.
 */
import type { Step1SessionItem, Step1SessionMode } from '@/lib/usmle/step1-contract';
import { REVIEW_CHALLENGE_POLICY_VERSION } from '@/lib/study/review-challenge';
import type { ReviewChallengePreference } from '@/lib/study/review-challenge-preference';
import type { AnatomyCardMediaDescriptor } from './anatomy-card-media';
import { isAnatomyFigureSelection } from './anatomy-figure-catalogue';

export const COHORT_CARD_DELIVERY_CONTRACT = 'cohort-module-card-v1' as const;
export const COHORT_CARD_DECISION_PATH = 'cohort-module-card-v1' as const;

export interface CohortCardSessionItem {
  deliveryId: string;
  kind: 'card';
  /** One cloze blank, written `[___]`. */
  front: string;
  back: string;
  context: string | null;
  /** Optional exact-match descriptor for a reviewed, closed-registry figure. */
  media?: AnatomyCardMediaDescriptor;
  /** The module's display name. */
  domain: string;
  attribution: { text: string; licence: string };
}

export type CohortTurnItem = Step1SessionItem | CohortCardSessionItem;

export interface CohortTurnResult {
  sessionId: string;
  mode: Step1SessionMode;
  requestedSize: number;
  deliveredSize: number;
  items: CohortTurnItem[];
  reviewChallengeExhausted?: ReviewChallengePreference;
}

const CARD_KEYS = ['deliveryId', 'kind', 'front', 'back', 'context', 'domain', 'attribution', 'media'];
const BLANK = '[___]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, i) => key === actual[i]);
}

export function isCohortCardSessionItem(value: unknown): value is CohortCardSessionItem {
  return isRecord(value) && value.kind === 'card';
}

/** The exact card item shape, or null. Anything else is refused, never repaired. */
export function parseCohortCardSessionItem(value: unknown): CohortCardSessionItem | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    ...CARD_KEYS.filter((key) => key !== 'media'),
    ...('media' in value ? ['media'] : []),
  ]) || value.kind !== 'card') return null;
  if (
    typeof value.deliveryId !== 'string' || value.deliveryId.length === 0
    || typeof value.front !== 'string' || value.front.split(BLANK).length !== 2
    || typeof value.back !== 'string' || value.back.trim().length === 0
    || (value.context !== null && typeof value.context !== 'string')
    || typeof value.domain !== 'string' || value.domain.length === 0
    || !isRecord(value.attribution)
    || !hasExactKeys(value.attribution, ['text', 'licence'])
    || typeof value.attribution.text !== 'string' || value.attribution.text.length === 0
    || typeof value.attribution.licence !== 'string' || value.attribution.licence.length === 0
  ) return null;
  if ('media' in value) {
    const media = value.media;
    if (!isRecord(media)
      || !hasExactKeys(media, ['figureId', 'target', 'role', 'preAnswerAlt', 'postAnswerAlt'])
      || !isAnatomyFigureSelection(media.figureId, media.target, media.role)
      || typeof media.preAnswerAlt !== 'string' || media.preAnswerAlt.trim().length === 0
      || typeof media.postAnswerAlt !== 'string' || media.postAnswerAlt.trim().length === 0
    ) return null;
  }
  return value as unknown as CohortCardSessionItem;
}

/** A public exhaustion receipt contains policy state only, never gap or learner data. */
export function parseCohortChallengeExhaustion(value: unknown): ReviewChallengePreference | null {
  if (!isRecord(value) || !hasExactKeys(value, ['level', 'revision', 'policy'])
    || value.level !== 2 || value.policy !== REVIEW_CHALLENGE_POLICY_VERSION
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return null;
  return { level: 2, revision: Number(value.revision), policy: REVIEW_CHALLENGE_POLICY_VERSION };
}
