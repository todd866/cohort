/**
 * Study blend for personal exam-timed decks. Each active PersonalDeck contributes
 * an exam-proximity weight (front-loaded → decay → final-stretch burst → 0 after the
 * exam); PWH is constant; CAH takes the remainder. Pure functions of the date + the
 * deck registry — no clock access — so deterministic and unit-testable. The per-deck
 * shape lives in src/lib/personal-decks.ts (one registry entry per deck).
 * See docs/superpowers/specs/2026-07-22-personal-deck-registry-design.md.
 */
import {
  startOfUtcDayMs,
  subtractUtcDays,
} from './scheduler-config';
import type { PersonalDeck } from '../personal-decks';

const DEFAULT_FLOOR = 0.10;
const DEFAULT_BURST = 0.35;
const DEFAULT_WINDOW_DAYS = 48;
const DEFAULT_BURST_DAYS = 10;

/**
 * Generic exam-proximity weight for a personal deck (the parameterised form of the
 * old MND-specific curve). Retired/self-paced/past-exam handled first; otherwise a
 * linear decay `blendShare → floor` across the window, then a `burst` in the final
 * stretch, then 0 after the exam.
 */
export function examProximityWeight(deck: PersonalDeck, today: Date): number {
  const day = startOfUtcDayMs(today);
  if (deck.retiredAt && day >= startOfUtcDayMs(new Date(`${deck.retiredAt}T00:00:00Z`))) return 0;
  if (deck.examDate == null) return deck.blendShare; // self-paced → flat
  const exam = startOfUtcDayMs(new Date(`${deck.examDate}T00:00:00Z`));
  if (day >= exam) return 0; // past exam → auto-retire

  const floor = deck.floor ?? DEFAULT_FLOOR;
  const burst = deck.burst ?? DEFAULT_BURST;
  const windowDays = deck.windowDays ?? DEFAULT_WINDOW_DAYS;
  const burstDays = deck.burstDays ?? DEFAULT_BURST_DAYS;
  const windowStart = subtractUtcDays(exam, windowDays);
  const burstStart = subtractUtcDays(exam, burstDays);

  if (day >= burstStart) return burst;
  if (day < windowStart) return deck.blendShare;
  const span = burstStart - windowStart;
  const t = Math.min(1, Math.max(0, (day - windowStart) / span));
  return deck.blendShare - (deck.blendShare - floor) * t;
}

const PWH_SHARE = 0.10;

/**
 * Legacy planning helper retained for historical audit/tests. Personal decks
 * are now explicit-focus only and this map is not wired into the homepage.
 * Each active personal deck takes its exam-proximity weight; PWH keeps its
 * fixed share and CAH absorbs the remainder.
 * Returns a rotation→weight map (the shape `computeFetchSlots`'s `weights` accepts).
 */
export function computeStudyBlend(today: Date, activeDecks: PersonalDeck[]): Record<string, number> {
  const weights: Record<string, number> = {};
  let personalTotal = 0;
  for (const deck of activeDecks) {
    const w = examProximityWeight(deck, today);
    if (w > 0) {
      weights[deck.slug] = w;
      personalTotal += w;
    }
  }
  weights.pwh = PWH_SHARE;
  weights.cah = Math.max(0, 1 - personalTotal - PWH_SHARE);
  return weights;
}
