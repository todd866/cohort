'use client';

import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import type { StaticImageData } from 'next/image';
import { shuffle } from '@/lib/utils/shuffle';
import { genClientRequestId } from '@/lib/client-request-id';
import { useImageOcclusionTracking } from '@/hooks/useTracking';
import { ContentFlag } from './ContentFlag';
import { normalizeSnapshot } from './content-flag-utils';
import {
  CLIENT_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';

export interface OcclusionRegion {
  id: string;
  label: string;
  x: number; // 0-1
  y: number; // 0-1
  w: number; // 0-1
  h: number; // 0-1
}

interface RegionState {
  revealed: boolean;
  knew: boolean | null;
}

interface ImageOcclusionProps {
  id: string;
  title?: string;
  src: string | StaticImageData;
  alt: string;
  regions: OcclusionRegion[];
  occlude?: 'all' | 'random';
  occludeCount?: number;
  rotation?: string;
  week?: number;
  topics?: string[];
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function resolveSrc(src: string | StaticImageData): string {
  return typeof src === 'string' ? src : src.src;
}

function pickRegions(
  regions: OcclusionRegion[],
  occlude: 'all' | 'random',
  occludeCount: number | undefined
): OcclusionRegion[] {
  const normalized = regions.map((r) => ({
    ...r,
    x: clamp01(r.x),
    y: clamp01(r.y),
    w: clamp01(r.w),
    h: clamp01(r.h),
  }));

  if (occlude !== 'random') return normalized;
  if (!occludeCount || occludeCount <= 0) return normalized;
  if (occludeCount >= normalized.length) return normalized;

  return shuffle(normalized).slice(0, occludeCount);
}

export function ImageOcclusion({
  id,
  title,
  src,
  alt,
  regions,
  occlude = 'all',
  occludeCount,
  rotation,
  week,
  topics = [],
}: ImageOcclusionProps) {
  const { onStart, onComplete } = useImageOcclusionTracking(id);
  const hasStarted = useRef(false);
  const [quizComplete, setQuizComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pendingRequestId = useRef<string | null>(null);
  const [quiz, setQuiz] = useState<{
    regions: OcclusionRegion[];
    states: Map<string, RegionState>;
  }>(() => {
    const selected = pickRegions(regions, occlude, occludeCount);
    return {
      regions: selected,
      states: new Map(selected.map((r) => [r.id, { revealed: false, knew: null }])),
    };
  });

  const [activeRegionId, setActiveRegionId] = useState<string | null>(null);

  const activeRegion = useMemo(() => {
    if (!activeRegionId) return null;
    return quiz.regions.find((r) => r.id === activeRegionId) ?? null;
  }, [activeRegionId, quiz.regions]);

  const resolvedSrc = useMemo(() => resolveSrc(src), [src]);

  const regionLabels = useMemo(
    () => regions.map((r) => r.label).filter(Boolean).slice(0, 6).join(' '),
    [regions]
  );
  const flagSnapshot = useMemo(
    () => normalizeSnapshot([title || 'Image Review', alt, regionLabels].filter(Boolean).join(' ')),
    [title, alt, regionLabels]
  );

  const allAnswered = useMemo(() => {
    return quiz.regions.every((r) => quiz.states.get(r.id)?.knew !== null);
  }, [quiz.regions, quiz.states]);

  const results = useMemo(() => {
    const states = quiz.regions.map((r) => quiz.states.get(r.id));
    const correct = states.filter((s) => s?.knew === true).length;
    const total = quiz.regions.length;
    const answered = states.filter((s) => s?.knew !== null).length;
    return {
      correct,
      incorrect: answered - correct,
      total,
      percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
    };
  }, [quiz.regions, quiz.states]);

  const revealRegion = useCallback((regionId: string) => {
    if (quizComplete) return;

    if (!hasStarted.current) {
      hasStarted.current = true;
      onStart();
    }

    setQuiz((prev) => {
      const nextStates = new Map(prev.states);
      const current = nextStates.get(regionId);
      if (current && !current.revealed) {
        nextStates.set(regionId, { ...current, revealed: true });
      }
      return { ...prev, states: nextStates };
    });

    setActiveRegionId(regionId);
  }, [quizComplete, onStart]);

  const markActive = useCallback((knew: boolean, regionIdOverride?: string) => {
    const targetId = regionIdOverride ?? activeRegionId;
    if (!targetId) return;
    if (quizComplete) return;

    setQuiz((prev) => {
      const nextStates = new Map(prev.states);
      const current = nextStates.get(targetId);
      if (current) {
        nextStates.set(targetId, { ...current, knew });
      }
      return { ...prev, states: nextStates };
    });

    setActiveRegionId(null);
  }, [activeRegionId, quizComplete]);

  // Find next unrevealed region
  const nextUnrevealedRegion = useMemo(() => {
    return quiz.regions.find((r) => !quiz.states.get(r.id)?.revealed);
  }, [quiz.regions, quiz.states]);

  // Keyboard shortcuts: Space to reveal next, 1/J for knew, 2/K for missed
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (quizComplete) return;

    const key = e.key.toLowerCase();

    // Space reveals next unrevealed region
    if (key === ' ' && !activeRegion && nextUnrevealedRegion) {
      e.preventDefault();
      revealRegion(nextUnrevealedRegion.id);
      return;
    }

    // 1 or J = Knew it
    if ((key === '1' || key === 'j') && activeRegion) {
      e.preventDefault();
      markActive(true);
      return;
    }

    // 2 or K = Missed
    if ((key === '2' || key === 'k') && activeRegion) {
      e.preventDefault();
      markActive(false);
      return;
    }
  }, [quizComplete, activeRegion, nextUnrevealedRegion, revealRegion, markActive]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const submitResults = async () => {
    if (!allAnswered || submitting) return;
    setSubmitError(null);
    setSubmitting(true);

    try {
      const regionResults = quiz.regions.map((r) => ({
        regionId: r.id,
        label: r.label,
        knew: quiz.states.get(r.id)?.knew ?? false,
      }));

      if (!pendingRequestId.current) {
        pendingRequestId.current = genClientRequestId();
      }

      const response = await fetchWithDeadline('/api/quiz/image-occlusion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId: pendingRequestId.current,
          imageId: id,
          rotation,
          week,
          topics,
          results: regionResults,
        }),
      }, CLIENT_FETCH_DEADLINE_MS);

      if (!response.ok) {
        throw new Error(await responseError(response, 'Failed to save image occlusion results'));
      }

      pendingRequestId.current = null;
      onComplete(results.correct, results.total);
      setQuizComplete(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to save image occlusion results');
      console.error('Failed to submit image occlusion results:', error);
    } finally {
      setSubmitting(false);
    }
  };

  const resetQuiz = () => {
    setActiveRegionId(null);
    setQuizComplete(false);
    setSubmitError(null);
    setSubmitting(false);
    pendingRequestId.current = null;
    hasStarted.current = false;
    const nextRegions = pickRegions(regions, occlude, occludeCount);
    setQuiz({
      regions: nextRegions,
      states: new Map(nextRegions.map((r) => [r.id, { revealed: false, knew: null }])),
    });
  };

  if (regions.length === 0) return null;

  return (
    <div className="my-8 rounded-2xl bg-[var(--md-surface-container-low)] border border-[var(--md-outline-variant)] overflow-hidden">
      <div className="px-6 py-4 bg-[var(--md-surface-container)] border-b border-[var(--md-outline-variant)]">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 text-xs font-bold rounded-full bg-[var(--md-tertiary)] text-[var(--md-on-tertiary)]">
              IMAGE OCCLUSION
            </span>
            <span className="font-medium text-[var(--md-on-surface)]">
              {title || 'Image Review'}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm text-[var(--md-on-surface-variant)]">
            <span>{quiz.regions.length} regions to test</span>
            {!quizComplete && allAnswered && (
              <span className="text-green-600 dark:text-green-400 font-medium">
                Ready to submit
              </span>
            )}
            <ContentFlag
              targetType="component"
              targetId={id}
              componentType="ImageOcclusion"
              contentSnapshot={flagSnapshot}
            />
          </div>
        </div>
      </div>

      {!quizComplete && (
        <div className="px-6 py-3 bg-[var(--md-surface-container-lowest)] border-b border-[var(--md-outline-variant)] text-sm text-[var(--md-on-surface-variant)]">
          <span>Click regions to reveal, then mark knew/missed</span>
          <span className="hidden sm:inline text-[var(--md-outline)] ml-2">
            • Space: reveal • 1/J: knew • 2/K: missed
          </span>
        </div>
      )}

      <div className="p-4">
        <div className="relative w-full overflow-hidden rounded-xl border border-[var(--md-outline-variant)] bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resolvedSrc}
            alt={alt}
            loading="lazy"
            className="w-full h-auto block select-none"
          />

          {quiz.regions.map((region) => {
            const state = quiz.states.get(region.id);
            if (!state) return null;

            const left = `${region.x * 100}%`;
            const top = `${region.y * 100}%`;
            const width = `${region.w * 100}%`;
            const height = `${region.h * 100}%`;

            const isActive = activeRegionId === region.id;
            const borderColor =
              state.knew === true
                ? 'border-green-400'
                : state.knew === false
                  ? 'border-red-400'
                  : isActive
                    ? 'border-[var(--md-primary)]'
                    : 'border-[var(--md-tertiary)]';

            // Fully opaque background to completely hide content
            const background =
              !state.revealed
                ? 'bg-[var(--md-surface-container-highest)]'
                : 'bg-transparent';

            return (
              <button
                key={region.id}
                type="button"
                disabled={quizComplete || submitting}
                onClick={() => {
                  if (!state.revealed) {
                    revealRegion(region.id);
                  } else {
                    setActiveRegionId(region.id);
                  }
                }}
                style={{ left, top, width, height }}
                className={`absolute rounded-md border-2 ${borderColor} ${background} transition ${
                  quizComplete ? 'cursor-default' : 'cursor-pointer hover:brightness-95'
                } flex items-center justify-center`}
                aria-label={
                  state.revealed ? `Region revealed: ${region.label}` : `Reveal region: ${region.label}`
                }
              >
                {!state.revealed && (
                  <span className="px-2 py-1 text-xs font-medium rounded bg-black/40 text-white">
                    Reveal
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {!quizComplete && activeRegion && (
          <div className="mt-4 p-4 rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]">
            <div className="text-sm text-[var(--md-on-surface-variant)] mb-1">
              What was hidden here?
            </div>
            <div className="font-medium text-[var(--md-on-surface)] mb-3">
              {activeRegion.label}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => markActive(true)}
                disabled={submitting}
                className="flex-1 px-3 py-2 rounded-xl bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/60 transition-colors font-medium"
              >
                Knew it
              </button>
              <button
                type="button"
                onClick={() => markActive(false)}
                disabled={submitting}
                className="flex-1 px-3 py-2 rounded-xl bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors font-medium"
              >
                Missed
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="px-6 py-4 bg-[var(--md-surface-container)] border-t border-[var(--md-outline-variant)]">
        {quizComplete ? (
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div className="text-2xl font-bold text-[var(--md-on-surface)]">
                {results.percentage}%
              </div>
              <div className="text-sm text-[var(--md-on-surface-variant)]">
                <span className="text-green-600 dark:text-green-400 font-medium">{results.correct} correct</span>
                {' / '}
                <span className="text-red-600 dark:text-red-400 font-medium">{results.incorrect} missed</span>
              </div>
            </div>
            <button
              type="button"
              onClick={resetQuiz}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--md-outline)] text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]"
            >
              Try Again
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="text-sm text-[var(--md-on-surface-variant)]">
              Progress: {quiz.regions.filter((r) => quiz.states.get(r.id)?.knew !== null).length} / {quiz.regions.length}
            </div>
            <button
              type="button"
              onClick={submitResults}
              disabled={!allAnswered || submitting}
              className={`px-6 py-2 rounded-xl font-medium transition-all ${
                allAnswered && !submitting
                  ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)] hover:brightness-110'
                  : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] cursor-not-allowed'
              }`}
            >
              {submitting ? 'Saving...' : submitError ? 'Retry Save' : 'Submit Results'}
            </button>
            {submitError && !submitting && (
              <p className="w-full text-sm text-[var(--md-error)] text-right" role="alert">
                {submitError}. Your answers are still here.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}
