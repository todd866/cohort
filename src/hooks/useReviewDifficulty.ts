'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';
import {
  normalizeReviewChallengeLevel,
  type ReviewChallengeLevel,
  REVIEW_CHALLENGE_POLICY_VERSION,
} from '@/lib/study/review-challenge';
import type { ReviewChallengePreference } from '@/lib/study/review-challenge-preference';

interface DifficultyResponse {
  level?: unknown;
  revision?: unknown;
  error?: unknown;
}

export type ReviewDifficultyEndpoint = '/api/study/difficulty' | '/api/cohort/difficulty';

export interface UseReviewDifficultyOptions {
  enabled: boolean;
  endpoint?: ReviewDifficultyEndpoint;
  offline?: boolean;
  identityKey?: string | null;
  /** Rebuild the unshown review reserve after a successful preference write. */
  onApplied?: (revision: number) => void | Promise<void>;
}

export interface UseReviewDifficultyResult {
  level: ReviewChallengeLevel;
  revision: number | null;
  pending: boolean;
  ready: boolean;
  error: string | null;
  commit: (level: number) => void;
  retry: () => void;
  easeAfterExhaustion: (receipt: ReviewChallengePreference) => void;
  adjustment: string | null;
}

function readLevel(value: unknown): ReviewChallengeLevel {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -2 || value > 2) {
    throw new Error('Difficulty preference response was invalid');
  }
  return value as ReviewChallengeLevel;
}

function readRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

async function readDifficulty(endpoint: ReviewDifficultyEndpoint, signal?: AbortSignal): Promise<{ level: ReviewChallengeLevel; revision: number }> {
  const response = await fetchWithDeadline(endpoint, { signal, cache: 'no-store' }, CLIENT_FETCH_DEADLINE_MS);
  const body = await response.json().catch(() => ({})) as DifficultyResponse;
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
  const revision = readRevision(body.revision);
  if (revision === null) throw new Error('Difficulty preference response was invalid');
  return { level: readLevel(body.level), revision };
}

/** Loads and serializes the authenticated learner's review challenge preference. */
export function useReviewDifficulty({ enabled, endpoint = '/api/study/difficulty', offline = false, identityKey = null, onApplied }: UseReviewDifficultyOptions): UseReviewDifficultyResult {
  const [level, setLevel] = useState<ReviewChallengeLevel>(0);
  const [revision, setRevision] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState<string | null>(null);
  const levelRef = useRef<ReviewChallengeLevel>(0);
  const automaticRevisionRef = useRef<number | null>(null);
  const revisionRef = useRef<number | null>(null);
  const desiredRef = useRef<ReviewChallengeLevel | null>(null);
  const runningRef = useRef(false);
  const generationRef = useRef(0);
  const appliedRetryRef = useRef<{ level: ReviewChallengeLevel; revision: number } | null>(null);
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;

  const reconcile = useCallback(() => readDifficulty(endpoint), [endpoint]);

  const save = useCallback(async (target: ReviewChallengeLevel, expectedRevision: number) => {
    const response = await fetchWithDeadline(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: target, expectedRevision }),
    }, CLIENT_FETCH_DEADLINE_MS);
    const body = await response.json().catch(() => ({})) as DifficultyResponse;
    if (response.status === 409) {
      const reconciled = await reconcile();
      // Keep the latest user intent after learning the server's revision.
      return { revision: reconciled.revision, level: reconciled.level, retry: true };
    }
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
    const nextRevision = readRevision(body.revision);
    if (nextRevision === null) throw new Error('Difficulty save response was invalid');
    const nextLevel = readLevel(body.level);
    return { revision: nextRevision, level: nextLevel, retry: false };
  }, [endpoint, reconcile]);

  const drain = useCallback(async () => {
    if (runningRef.current || offline || !enabled) return;
    runningRef.current = true;
    const generation = generationRef.current;
    let activeTarget: ReviewChallengeLevel | null = null;
    let conflictRetries = 0;
    let activeAutomaticRevision: number | null = null;
    setPending(true);
    setError(null);
    try {
      while (desiredRef.current !== null) {
        if (generationRef.current !== generation) return;
        const target = desiredRef.current;
        const automaticRevision = automaticRevisionRef.current;
        activeAutomaticRevision = automaticRevision;
        automaticRevisionRef.current = null;
        activeTarget = target;
        desiredRef.current = null;
        let expected = automaticRevision ?? revisionRef.current;
        if (expected === null) {
          const loaded = await reconcile();
          expected = loaded.revision;
        }
        const saved = await save(target, expected);
        if (generationRef.current !== generation) return;
        revisionRef.current = saved.revision;
        setRevision(saved.revision);
        if (saved.retry && automaticRevision !== null) {
          // Automatic easing must yield to a newer choice on this or another device.
          activeTarget = null;
          setAdjustment(null);
          if (desiredRef.current === null) {
            levelRef.current = saved.level;
            setLevel(saved.level);
            await onAppliedRef.current?.(saved.revision);
          }
          continue;
        }
        if (saved.retry) {
          conflictRetries += 1;
          if (conflictRetries > 3) throw new Error('Difficulty changed repeatedly. Please retry.');
          if (desiredRef.current === null) desiredRef.current = target;
          continue;
        }
        conflictRetries = 0;
        // A newer pointer/key choice already superseded this completed write.
        if (desiredRef.current !== null) continue;
        levelRef.current = saved.level;
        setLevel(saved.level);
        setReady(false);
        try {
          await onAppliedRef.current?.(saved.revision);
        } catch (cause) {
          appliedRetryRef.current = { level: saved.level, revision: saved.revision };
          throw cause;
        }
        if (generationRef.current !== generation) return;
        appliedRetryRef.current = null;
        setReady(true);
      }
    } catch (cause) {
      // Keep desiredRef so Retry can repeat the exact intended write.
      if (generationRef.current === generation) {
        if (activeAutomaticRevision !== null) setAdjustment(null);
        if (desiredRef.current === null && activeTarget !== null && appliedRetryRef.current === null && activeAutomaticRevision === null) desiredRef.current = activeTarget;
        setError(cause instanceof Error ? cause.message : 'Could not save difficulty');
      }
    } finally {
      if (generationRef.current === generation) {
        runningRef.current = false;
        setPending(false);
      }
    }
  }, [enabled, offline, reconcile, save]);

  const commit = useCallback((next: number) => {
    if (!enabled || offline) return;
    const normalized = normalizeReviewChallengeLevel(next);
    automaticRevisionRef.current = null;
    setAdjustment(null);
    levelRef.current = normalized;
    setLevel(normalized);
    desiredRef.current = normalized;
    void drain();
  }, [drain, enabled, offline]);

  const easeAfterExhaustion = useCallback((receipt: ReviewChallengePreference) => {
    if (!enabled || offline || receipt.level !== 2 || receipt.policy !== REVIEW_CHALLENGE_POLICY_VERSION
      || receipt.revision !== revisionRef.current || levelRef.current !== 2
      || desiredRef.current !== null || appliedRetryRef.current !== null) return;
    automaticRevisionRef.current = receipt.revision;
    desiredRef.current = 1;
    levelRef.current = 1;
    setLevel(1);
    setAdjustment('Switched to Harder');
    void drain();
  }, [drain, enabled, offline]);

  const retry = useCallback(() => {
    const appliedRetry = appliedRetryRef.current;
    if (appliedRetry !== null) {
      const generation = generationRef.current;
      setPending(true);
      setError(null);
      void reconcile().then((loaded) => {
        if (generationRef.current !== generation) return null;
        revisionRef.current = loaded.revision;
        setRevision(loaded.revision);
        levelRef.current = loaded.level;
        setLevel(loaded.level);
        return loaded.revision;
      }).then((authoritativeRevision) => {
        if (authoritativeRevision === null || authoritativeRevision === undefined) return;
        return onAppliedRef.current?.(authoritativeRevision);
      }).then(() => {
        if (generationRef.current !== generation) return;
        appliedRetryRef.current = null;
        setReady(true);
        setPending(false);
        // A newer interaction may have been coalesced while the failed
        // reserve refresh was being retried. Reconcile the saved revision
        // first, then drain that latest intent rather than dropping it.
        if (desiredRef.current !== null) void drain();
      }).catch((cause: unknown) => {
        if (generationRef.current !== generation) return;
        setError(cause instanceof Error ? cause.message : 'Could not prepare the next question');
        setPending(false);
      });
      return;
    }
    if (desiredRef.current !== null) {
      void drain();
      return;
    }
    if (!enabled || offline) return;
    const generation = generationRef.current;
    void reconcile().then((loaded) => {
      if (generationRef.current !== generation) return;
      revisionRef.current = loaded.revision;
      setRevision(loaded.revision);
      levelRef.current = loaded.level;
      setLevel(loaded.level);
      appliedRetryRef.current = null;
      setError(null);
      setReady(true);
    }).catch((cause: unknown) => {
      if (generationRef.current === generation) setError(cause instanceof Error ? cause.message : 'Could not load difficulty');
    });
  }, [drain, enabled, offline, reconcile]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    runningRef.current = false;
    desiredRef.current = null;
    automaticRevisionRef.current = null;
    setAdjustment(null);
    appliedRetryRef.current = null;
    revisionRef.current = null;
    setRevision(null);
    if (!enabled) {
      desiredRef.current = null;
      setReady(false);
      setPending(false);
      setError(null);
      return;
    }
    if (offline) {
      setReady(false);
      return;
    }
    const controller = new AbortController();
    setReady(false);
    setPending(true);
      void readDifficulty(endpoint, controller.signal).then((loaded) => {
      if (generationRef.current !== generation) return;
      revisionRef.current = loaded.revision;
      setRevision(loaded.revision);
      levelRef.current = loaded.level;
      setLevel(loaded.level);
      setReady(true);
      setPending(false);
    }).catch((cause: unknown) => {
      if (generationRef.current !== generation || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Could not load difficulty');
      setPending(false);
    });
    return () => controller.abort();
  }, [enabled, endpoint, offline, identityKey]);

  return { level, revision, pending, ready, error, commit, retry, easeAfterExhaustion, adjustment };
}
