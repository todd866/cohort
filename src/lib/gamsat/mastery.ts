/**
 * Per-move mastery, accumulated in the browser.
 *
 * v1 keeps this entirely client-side: no account, no database, no server write.
 * A guest can walk in off the landing page and start working immediately, which
 * is the whole point of `/gamsat` being a session rather than a signup funnel.
 *
 * The pure functions here are the testable core; `loadMastery`/`saveMastery` are
 * the thin storage shell.
 */
import type { MasteryState, MoveRecord } from './types';

export const MASTERY_STORAGE_KEY = 'gamsat:mastery:v1';
export const RECENT_STORAGE_KEY = 'gamsat:recent-passages:v1';

/** How many passages to keep out of rotation before repeating one. */
export const RECENT_PASSAGE_MEMORY = 4;

export function applyAnswer(
  state: MasteryState,
  moves: string[],
  isCorrect: boolean,
): MasteryState {
  const next: MasteryState = { ...state };
  for (const move of moves) {
    const current = next[move] ?? { correct: 0, total: 0 };
    next[move] = {
      correct: current.correct + (isCorrect ? 1 : 0),
      total: current.total + 1,
    };
  }
  return next;
}

function isRecord(value: unknown): value is MoveRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<MoveRecord>;
  if (typeof candidate.correct !== 'number' || typeof candidate.total !== 'number') return false;
  if (!Number.isFinite(candidate.correct) || !Number.isFinite(candidate.total)) return false;
  // Reject impossible counters rather than letting them poison weakness scores.
  if (candidate.correct < 0 || candidate.total < 0) return false;
  return candidate.correct <= candidate.total;
}

/** Parse stored mastery, discarding anything malformed. Never throws. */
export function parseMastery(raw: string | null): MasteryState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const state: MasteryState = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isRecord(value)) state[key] = { correct: value.correct, total: value.total };
  }
  return state;
}

export function serialiseMastery(state: MasteryState): string {
  return JSON.stringify(state);
}

export interface MasteryRow {
  moveId: string;
  accuracy: number;
  attempts: number;
}

/** Attempted moves, weakest first — the learner-facing view of the manifold. */
export function masteryReport(state: MasteryState): MasteryRow[] {
  return Object.entries(state)
    .filter(([, record]) => record.total > 0)
    .map(([moveId, record]) => ({
      moveId,
      accuracy: record.correct / record.total,
      attempts: record.total,
    }))
    .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts);
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage can throw outright in private modes and locked-down embeds.
    return null;
  }
}

export function loadMastery(): MasteryState {
  return parseMastery(storage()?.getItem(MASTERY_STORAGE_KEY) ?? null);
}

export function saveMastery(state: MasteryState): void {
  try {
    storage()?.setItem(MASTERY_STORAGE_KEY, serialiseMastery(state));
  } catch {
    // A full or blocked quota must never break the session in progress.
  }
}

export function loadRecentPassages(): string[] {
  try {
    const raw = storage()?.getItem(RECENT_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

export function pushRecentPassage(id: string, existing: string[]): string[] {
  const next = [id, ...existing.filter((value) => value !== id)].slice(0, RECENT_PASSAGE_MEMORY);
  try {
    storage()?.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal; selection just loses its recency memory.
  }
  return next;
}
