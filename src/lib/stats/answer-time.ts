/**
 * Median answer time for the sorting hat. Untimed answers (null responseMs)
 * do not count. Each sample is capped at 60s before the median, matching the
 * statistics query. The result is seconds, unrounded; the hat rounds only
 * when it prints the line.
 */
import { ANSWER_TIME_CAP_MS } from './stats-model';

export const TIMED_ANSWER_MIN = 30;

export function capAnswerMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(ANSWER_TIME_CAP_MS, Math.max(0, ms));
}

/** Null until TIMED_ANSWER_MIN non-null samples exist. */
export function medianCappedAnswerSeconds(samplesMs: readonly (number | null | undefined)[]): number | null {
  const capped: number[] = [];
  for (const ms of samplesMs) {
    if (ms == null || !Number.isFinite(ms)) continue;
    capped.push(capAnswerMs(ms));
  }
  if (capped.length < TIMED_ANSWER_MIN) return null;
  capped.sort((a, b) => a - b);
  const mid = Math.floor(capped.length / 2);
  const medianMs = capped.length % 2 === 1 ? capped[mid]! : (capped[mid - 1]! + capped[mid]!) / 2;
  return medianMs / 1000;
}
