'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  findExamStep,
  lessonScenesForTrack,
  resolveClinicalLessonSceneSteps,
  type ClinicalExam,
  type ClinicalLesson as ClinicalLessonData,
  type ClinicalLessonScene,
  type ProtocolSource,
} from '@/lib/clinical-exams';
import { ClinicalLessonVisual } from './clinical-lesson-visuals';

interface ClinicalLessonProps {
  exam: ClinicalExam;
  lesson: ClinicalLessonData;
  sources?: ProtocolSource[];
  onExit?: () => void;
}

const SCENE_KIND_LABELS: Record<ClinicalLessonScene['kind'], string> = {
  briefing: 'Orient',
  technique: 'Technique',
  sequence: 'Sequence',
  recall: 'Recall',
};

function labelTrack(track: string): string {
  return track.charAt(0).toUpperCase() + track.slice(1);
}

function firstTrack(lesson: ClinicalLessonData): string {
  if (Object.hasOwn(lesson.tracks, lesson.defaultTrack)) {
    return lesson.defaultTrack;
  }
  return Object.keys(lesson.tracks)[0] ?? '';
}

const LESSON_LOCATION_EVENT = 'md3:clinical-lesson-location';

function parseLessonHash(
  lesson: ClinicalLessonData,
  hash: string,
): { track: string; sceneIndex: number } | null {
  const [encodedTrack, encodedScene] = hash.slice(1).split('/');
  if (!encodedTrack || !encodedScene) return null;

  try {
    const track = decodeURIComponent(encodedTrack);
    const sceneId = decodeURIComponent(encodedScene);
    const sceneIndex = lesson.tracks[track]?.indexOf(sceneId) ?? -1;
    return sceneIndex >= 0 ? { track, sceneIndex } : null;
  } catch {
    return null;
  }
}

function writeLessonHash(track: string, sceneId: string) {
  const hash = `#${encodeURIComponent(track)}/${encodeURIComponent(sceneId)}`;
  const nextUrl = `${window.location.pathname}${window.location.search}${hash}`;
  window.history.replaceState(window.history.state, '', nextUrl);
  window.dispatchEvent(new Event(LESSON_LOCATION_EVENT));
}

function subscribeLessonLocation(onStoreChange: () => void): () => void {
  window.addEventListener('hashchange', onStoreChange);
  window.addEventListener(LESSON_LOCATION_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('hashchange', onStoreChange);
    window.removeEventListener(LESSON_LOCATION_EVENT, onStoreChange);
  };
}

function getLessonLocationSnapshot(): string {
  return window.location.hash;
}

function getLessonLocationServerSnapshot(): string {
  return '';
}

function isEditableOrInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        'a, button, input, select, textarea, [contenteditable="true"], [role="dialog"]',
      ),
    )
  );
}

function LessonExit({
  exam,
  onExit,
}: {
  exam: ClinicalExam;
  onExit?: () => void;
}) {
  const className =
    'inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container)] hover:text-[var(--md-on-surface)]';

  if (onExit) {
    return (
      <button type="button" onClick={onExit} className={className}>
        <span aria-hidden>←</span>
        Bedside checklist
      </button>
    );
  }

  return (
    <Link href={`/exams/${exam.slug}`} className={className}>
      <span aria-hidden>←</span>
      Bedside checklist
    </Link>
  );
}

function CanonicalSteps({
  exam,
  scene,
}: {
  exam: ClinicalExam;
  scene: ClinicalLessonScene;
}) {
  const steps = resolveClinicalLessonSceneSteps(exam, scene);

  if (steps.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
        This scene is an orientation layer; the marked actions begin in the
        next scene.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {steps.map((step, index) => (
        <li key={step.id ?? step.text} className="flex gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--md-primary-container)] text-xs font-bold tabular-nums text-[var(--md-on-primary-container)]">
            {index + 1}
          </span>
          <div className="min-w-0 pt-0.5">
            <p className="text-[0.98rem] font-medium leading-snug text-[var(--md-on-surface)]">
              {step.text}
            </p>
            {step.note ? (
              <p className="mt-1 text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
                {step.note}
              </p>
            ) : null}
            {step.critical ? (
              <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-[var(--md-error-container)] px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-[0.08em] text-[var(--md-on-error-container)]">
                <span aria-hidden>▲</span>
                Explicitly marked
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function RecallPanel({
  exam,
  scene,
  revealed,
  onReveal,
}: {
  exam: ClinicalExam;
  scene: Extract<ClinicalLessonScene, { kind: 'recall' }>;
  revealed: boolean;
  onReveal: () => void;
}) {
  const revealSteps = scene.revealStepIds.flatMap((id) => {
    const step = findExamStep(exam, id);
    return step ? [step] : [];
  });

  return (
    <section
      aria-labelledby="clinical-lesson-recall"
      className="rounded-2xl border border-[var(--md-primary)] bg-[var(--md-primary-container)] p-4 sm:p-5"
    >
      <p
        id="clinical-lesson-recall"
        className="text-[0.7rem] font-bold uppercase tracking-[0.12em] text-[var(--md-on-primary-container)]"
      >
        Close the loop
      </p>
      <p className="mt-2 text-lg font-semibold leading-snug text-[var(--md-on-primary-container)]">
        {scene.prompt}
      </p>

      {!revealed ? (
        <button
          type="button"
          onClick={onReveal}
          className="mt-4 min-h-11 rounded-xl bg-[var(--md-primary)] px-4 py-2.5 text-sm font-bold text-[var(--md-on-primary)] shadow-[var(--md-shadow-1)] hover:brightness-105"
        >
          Reveal critical omissions
        </button>
      ) : (
        <div
          className="clinical-scene-enter mt-4 rounded-xl bg-[var(--md-surface-container-lowest)] p-4"
          aria-live="polite"
        >
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.1em] text-[var(--md-on-surface-variant)]">
            Critical omissions to compare
          </p>
          <ol className="space-y-2.5">
            {revealSteps.map((step, index) => (
              <li key={step.id ?? step.text} className="flex gap-3">
                <span className="w-5 shrink-0 pt-0.5 text-right text-xs font-bold tabular-nums text-[var(--md-primary)]">
                  {index + 1}
                </span>
                <span className="text-sm font-medium leading-snug text-[var(--md-on-surface)]">
                  {step.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

export function ClinicalLesson({
  exam,
  lesson,
  sources,
  onExit,
}: ClinicalLessonProps) {
  const initialTrack = firstTrack(lesson);
  const lessonHash = useSyncExternalStore(
    subscribeLessonLocation,
    getLessonLocationSnapshot,
    getLessonLocationServerSnapshot,
  );
  const lessonLocation = useMemo(
    () => parseLessonHash(lesson, lessonHash),
    [lesson, lessonHash],
  );
  const selectedTrack = lessonLocation?.track ?? initialTrack;
  const sceneIndex = lessonLocation?.sceneIndex ?? 0;
  const [detailScene, setDetailScene] = useState<string | null>(null);
  const [revealedRecallScene, setRevealedRecallScene] = useState<string | null>(
    null,
  );

  const sceneHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailTriggerRef = useRef<HTMLButtonElement>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const detailDialogRef = useRef<HTMLElement>(null);
  const priorSceneRef = useRef<string | null>(null);
  const detailWasOpenRef = useRef(false);

  const tracks = useMemo(() => Object.keys(lesson.tracks), [lesson.tracks]);
  const scenes = useMemo(
    () => lessonScenesForTrack(lesson, selectedTrack),
    [lesson, selectedTrack],
  );
  const safeSceneIndex = Math.min(sceneIndex, Math.max(0, scenes.length - 1));
  const scene = scenes[safeSceneIndex] ?? null;
  const sceneKey = scene ? `${selectedTrack}/${scene.id}` : null;
  const detailOpen = detailScene === sceneKey;
  const recallRevealed = revealedRecallScene === sceneKey;

  const selectScene = useCallback(
    (nextIndex: number) => {
      const lastIndex = Math.max(0, scenes.length - 1);
      const nextScene = scenes[Math.min(Math.max(nextIndex, 0), lastIndex)];
      if (nextScene) writeLessonHash(selectedTrack, nextScene.id);
    },
    [scenes, selectedTrack],
  );

  const closeDetail = useCallback(() => {
    setDetailScene(null);
  }, []);

  useEffect(() => {
    if (!scene || parseLessonHash(lesson, window.location.hash)) return;
    writeLessonHash(selectedTrack, scene.id);
  }, [lesson, scene, selectedTrack]);

  useEffect(() => {
    if (!sceneKey) return;

    if (priorSceneRef.current && priorSceneRef.current !== sceneKey) {
      sceneHeadingRef.current?.focus({ preventScroll: true });
      sceneHeadingRef.current?.scrollIntoView?.({
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
        block: 'start',
      });
    }
    priorSceneRef.current = sceneKey;
  }, [sceneKey]);

  useEffect(() => {
    if (detailOpen) {
      detailWasOpenRef.current = true;
      detailCloseRef.current?.focus();
      return;
    }
    if (detailWasOpenRef.current) {
      detailWasOpenRef.current = false;
      detailTriggerRef.current?.focus();
    }
  }, [detailOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && detailOpen) {
        event.preventDefault();
        closeDetail();
        return;
      }
      if (detailOpen || isEditableOrInteractive(event.target)) return;
      if (event.key === 'ArrowLeft' && safeSceneIndex > 0) {
        event.preventDefault();
        selectScene(safeSceneIndex - 1);
      } else if (
        event.key === 'ArrowRight' &&
        safeSceneIndex < scenes.length - 1
      ) {
        event.preventDefault();
        selectScene(safeSceneIndex + 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    closeDetail,
    detailOpen,
    safeSceneIndex,
    scenes.length,
    selectScene,
  ]);

  if (!scene) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-10">
        <LessonExit exam={exam} onExit={onExit} />
        <h1 className="mt-6 text-2xl font-bold text-[var(--md-on-surface)]">
          Walkthrough unavailable
        </h1>
        <p className="mt-2 text-sm text-[var(--md-on-surface-variant)]">
          The bedside checklist is still available in full.
        </p>
      </div>
    );
  }

  const canGoBack = safeSceneIndex > 0;
  const canGoNext = safeSceneIndex < scenes.length - 1;
  const sourceLabels = (scene.sourceIds ?? []).map(
    (sourceId) =>
      sources?.find((source) => source.id === sourceId)?.label ?? sourceId,
  );

  return (
    <div className="min-h-[100dvh] bg-[var(--md-surface)] pb-48 text-[var(--md-on-surface)] md:pb-28 lg:pb-8">
      <header className="border-b border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)]">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <LessonExit exam={exam} onExit={onExit} />
            <p className="text-xs font-semibold tabular-nums text-[var(--md-on-surface-variant)]">
              {labelTrack(selectedTrack)} · {safeSceneIndex + 1} of{' '}
              {scenes.length}
            </p>
          </div>

          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[var(--md-primary)]">
                Visual walkthrough
              </p>
              <h1 className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">
                {lesson.title}
              </h1>
            </div>

            {tracks.length > 1 ? (
              <div
                className="grid grid-flow-col gap-1 rounded-xl bg-[var(--md-surface-container)] p-1"
                role="group"
                aria-label="Choose walkthrough system"
              >
                {tracks.map((track) => {
                  const active = track === selectedTrack;
                  return (
                    <button
                      key={track}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        const firstSceneId = lesson.tracks[track]?.[0];
                        if (firstSceneId) {
                          writeLessonHash(track, firstSceneId);
                        }
                      }}
                      className={`min-h-11 rounded-lg px-3 py-2 text-xs font-bold ${
                        active
                          ? 'bg-[var(--md-surface-container-lowest)] text-[var(--md-on-surface)] shadow-[var(--md-shadow-1)]'
                          : 'text-[var(--md-on-surface-variant)]'
                      }`}
                    >
                      {labelTrack(track)}
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="rounded-full bg-[var(--md-primary-container)] px-3 py-1.5 text-xs font-bold text-[var(--md-on-primary-container)]">
                {labelTrack(selectedTrack)}
              </span>
            )}
          </div>

          <nav
            className="mt-2 flex gap-1.5 overflow-x-auto"
            aria-label="Walkthrough scenes"
          >
            {scenes.map((candidate, index) => {
              const active = index === safeSceneIndex;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  aria-current={active ? 'step' : undefined}
                  aria-label={`Scene ${index + 1}: ${candidate.heading}`}
                  title={candidate.heading}
                  onClick={() => selectScene(index)}
                  className="group flex min-h-11 min-w-8 flex-1 items-center"
                >
                  <span
                    className={`h-2.5 w-full rounded-full transition-colors ${
                      active
                        ? 'bg-[var(--md-primary)]'
                        : 'bg-[var(--md-surface-container-highest)] group-hover:bg-[var(--md-outline)]'
                    }`}
                    aria-hidden
                  />
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <div
        key={sceneKey}
        className="clinical-scene-enter mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1.12fr)_minmax(21rem,0.88fr)] lg:items-start lg:gap-8 lg:px-8 lg:py-8"
      >
        <section aria-label="Teaching visual" className="lg:sticky lg:top-6">
          <ClinicalLessonVisual
            visualId={scene.visual.id}
            alt={scene.visual.alt}
            caption={scene.visual.caption}
            className="w-full"
          />
        </section>

        <article className="min-w-0">
          <p className="text-[0.7rem] font-bold uppercase tracking-[0.13em] text-[var(--md-primary)]">
            {SCENE_KIND_LABELS[scene.kind]} · {scene.context}
          </p>
          <h2
            ref={sceneHeadingRef}
            tabIndex={-1}
            className="mt-2 scroll-mt-6 rounded-sm text-[1.85rem] font-bold leading-[1.08] tracking-tight focus:outline-2 focus:outline-offset-4 focus:outline-[var(--md-primary)] sm:text-[2.25rem]"
          >
            {scene.heading}
          </h2>

          <div className="mt-6 rounded-2xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)] p-4 shadow-[var(--md-shadow-1)] sm:p-5">
            <p className="mb-4 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-[var(--md-on-surface-variant)]">
              {scene.kind === 'recall' ? 'Your turn' : 'What I do'}
            </p>
            {scene.kind === 'recall' ? (
              <RecallPanel
                exam={exam}
                scene={scene}
                revealed={recallRevealed}
                onReveal={() => setRevealedRecallScene(sceneKey)}
              />
            ) : (
              <CanonicalSteps exam={exam} scene={scene} />
            )}
          </div>

          <aside className="mt-4 rounded-2xl border-l-4 border-[var(--md-tertiary)] bg-[var(--md-tertiary-container)] px-4 py-3.5">
            <p className="text-[0.68rem] font-bold uppercase tracking-[0.12em] text-[var(--md-on-tertiary-container)]">
              Memory anchor
            </p>
            <p className="mt-1 text-[0.98rem] font-semibold leading-relaxed text-[var(--md-on-tertiary-container)]">
              {scene.takeaway}
            </p>
          </aside>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            {scene.detail ? (
              <button
                ref={detailTriggerRef}
                type="button"
                onClick={() => setDetailScene(sceneKey)}
                className="min-h-11 rounded-xl border border-[var(--md-outline)] px-4 py-2 text-sm font-semibold text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)]"
              >
                Show why
              </button>
            ) : (
              <span />
            )}
            <p className="max-w-sm text-right text-[0.68rem] leading-relaxed text-[var(--md-on-surface-variant)]">
              {sourceLabels.length > 0
                ? `Sources: ${sourceLabels.join(' · ')}`
                : exam.rubricSource
                  ? `Rubric source: ${exam.rubricSource}`
                  : 'Linked to the canonical bedside checklist'}
            </p>
          </div>
        </article>
      </div>

      <footer
        className="fixed left-0 right-0 z-20 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)]/95 px-4 py-3 shadow-[0_-8px_24px_rgba(21,35,46,0.08)] backdrop-blur sm:px-6 md:left-20 lg:static lg:border-t lg:shadow-none"
        style={{ bottom: 'var(--md-review-footer-bottom, 0px)' }}
      >
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <button
            type="button"
            disabled={!canGoBack}
            onClick={() => selectScene(safeSceneIndex - 1)}
            className="min-h-11 rounded-xl border border-[var(--md-outline-soft)] px-4 py-2 text-sm font-bold text-[var(--md-on-surface)] disabled:cursor-not-allowed disabled:opacity-35"
          >
            ← Back
          </button>
          {canGoNext ? (
            <button
              type="button"
              onClick={() => selectScene(safeSceneIndex + 1)}
              className="min-h-11 rounded-xl bg-[var(--md-primary)] px-5 py-2 text-sm font-bold text-[var(--md-on-primary)] shadow-[var(--md-shadow-1)] hover:brightness-105"
            >
              Next
              <span aria-hidden> →</span>
            </button>
          ) : onExit ? (
            <button
              type="button"
              onClick={onExit}
              className="min-h-11 rounded-xl bg-[var(--md-primary)] px-5 py-2 text-sm font-bold text-[var(--md-on-primary)] shadow-[var(--md-shadow-1)] hover:brightness-105"
            >
              Open bedside checklist
            </button>
          ) : (
            <Link
              href={`/exams/${exam.slug}`}
              className="inline-flex min-h-11 items-center rounded-xl bg-[var(--md-primary)] px-5 py-2 text-sm font-bold text-[var(--md-on-primary)] shadow-[var(--md-shadow-1)] hover:brightness-105"
            >
              Open bedside checklist
            </Link>
          )}
        </div>
      </footer>

      {detailOpen && scene.detail ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeDetail();
          }}
        >
          <section
            ref={detailDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="clinical-lesson-detail-title"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const focusable = Array.from(
                detailDialogRef.current?.querySelectorAll<HTMLElement>(
                  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
                ) ?? [],
              );
              const first = focusable[0];
              const last = focusable.at(-1);
              if (!first || !last) {
                event.preventDefault();
                return;
              }
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
            className="clinical-scene-enter w-full max-w-lg rounded-t-[var(--md-radius-xl)] bg-[var(--md-surface-container-lowest)] p-5 shadow-[var(--md-shadow-3)] sm:rounded-[var(--md-radius-xl)] sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[0.68rem] font-bold uppercase tracking-[0.12em] text-[var(--md-primary)]">
                  Why it matters
                </p>
                <h3
                  id="clinical-lesson-detail-title"
                  className="mt-1 text-xl font-bold leading-tight text-[var(--md-on-surface)]"
                >
                  {scene.heading}
                </h3>
              </div>
              <button
                ref={detailCloseRef}
                type="button"
                onClick={closeDetail}
                className="min-h-11 shrink-0 rounded-xl border border-[var(--md-outline-soft)] px-3 text-sm font-bold text-[var(--md-on-surface)]"
              >
                Close
              </button>
            </div>
            <p className="mt-5 text-base leading-relaxed text-[var(--md-on-surface)]">
              {scene.detail}
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
