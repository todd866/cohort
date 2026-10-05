'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import { CardText } from '@/components/shared/CardText';
import { AnatomyReviewFigure, prepareAnatomyFigure } from '@/components/shared/AnatomyReviewFigure';
import { reviewPaneGridClass, reviewShellWidthClass, REVIEW_PANE_TEXT_TOP, REVIEW_PANE_TEXT_BOTTOM, REVIEW_PANE_MEDIA } from '@/components/shared/review-pane-layout';
import { useReviewDifficulty } from '@/hooks/useReviewDifficulty';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { InlineMarkdown } from '@/lib/inline-markdown';
import { genClientRequestId } from '@/lib/client-request-id';
import { extractMarkdownTables, MarkdownTable } from '@/lib/inline-markdown';
import type { CohortExperience } from '@/lib/cohort/experience-prior';
import {
  fetchWithDeadline,
  CLIENT_FETCH_DEADLINE_MS,
  STUDY_SESSION_FETCH_DEADLINE_MS,
} from '@/lib/fetch-with-deadline';
import {
  isCohortCardSessionItem,
  parseCohortCardSessionItem,
  parseCohortChallengeExhaustion,
  type CohortCardSessionItem,
  type CohortTurnResult,
} from '@/lib/cohort/card-turn-contract';
import type { Step1SessionItem, Step1AnswerReveal } from '@/lib/usmle/step1-contract';

type Item = CohortCardSessionItem | Step1SessionItem;
type Profile = { hookCompletedAt: string | null; explicit: { experience?: CohortExperience } };
function newId(prefix: string) {
  return `${prefix}-${genClientRequestId()}`;
}
function isItem(value: unknown): value is Item {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (item.kind === 'card') return parseCohortCardSessionItem(item) !== null;
  const options = Array.isArray(item.options) ? item.options : [];
  const validOption = (option: unknown) => {
    if (!option || typeof option !== 'object') return false;
    const record = option as Record<string, unknown>;
    return (
      typeof record.label === 'string' &&
      record.label.trim().length > 0 &&
      typeof record.text === 'string' &&
      record.text.trim().length > 0
    );
  };
  return (
    typeof item.deliveryId === 'string' &&
    typeof item.stem === 'string' &&
    options.length > 0 &&
    new Set(
      options.map((option) =>
        option && typeof option === 'object' ? (option as Record<string, unknown>).label : null,
      ),
    ).size === options.length &&
    options.every(validOption) &&
    typeof item.domain === 'string'
  );
}
function parseTurn(value: unknown): CohortTurnResult {
  if (!value || typeof value !== 'object') throw new Error('The anatomy turn was invalid');
  const result = value as Record<string, unknown>;
  if (
    !Array.isArray(result.items) ||
    !Number.isSafeInteger(result.deliveredSize) ||
    result.deliveredSize !== result.items.length ||
    (result.deliveredSize !== 0 && result.deliveredSize !== 1) ||
    typeof result.sessionId !== 'string' ||
    typeof result.requestedSize !== 'number' ||
    result.items.some((item) => !isItem(item))
  )
    throw new Error('The anatomy turn contained unsafe content');
  return value as CohortTurnResult;
}
function RichText({ text }: { text: string }) {
  const extracted = extractMarkdownTables(text);
  if (!extracted || extracted.blocks.length === 0) return <InlineMarkdown text={text} />;
  return (
    <>
      {extracted.blocks.map((block, index) =>
        block.kind === 'table' ? (
          <MarkdownTable key={index} table={block.table} />
        ) : (
          <span key={index}>
            <InlineMarkdown text={block.text} />
          </span>
        ),
      )}
    </>
  );
}

export default function AnatomyStudyClient() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [queue, setQueue] = useState<Item[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [questionReveal, setQuestionReveal] = useState<Step1AnswerReveal | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [figureReady, setFigureReady] = useState(true);
  const journeyId = useRef(newId('anatomy-journey'));
  const ordinal = useRef(0);
  const previousDelivery = useRef<string | null>(null);
  const pendingTurn = useRef<Record<string, unknown> | null>(null);
  const pendingGrade = useRef<Record<string, unknown> | null>(null);
  const pendingAnswer = useRef<Record<string, unknown> | null>(null);
  const completedDelivery = useRef<string | null>(null);
  const advancing = useRef(false);
  const startedAt = useRef(Date.now());
  const automaticEase = useRef(false);
  const nextTurnRef = useRef<(size: 1) => Promise<void>>(async () => {});
  const { status: authStatus } = useSession();
  const authStatusRef = useRef(authStatus);
  authStatusRef.current = authStatus;
  const difficulty = useReviewDifficulty({
    enabled: authStatus === 'authenticated',
    endpoint: '/api/cohort/difficulty',
    onApplied: () => {
      if (automaticEase.current) {
        automaticEase.current = false;
        void nextTurnRef.current(1);
      }
    },
  });
  const difficultyRef = useRef(difficulty);
  difficultyRef.current = difficulty;

  const loadProfile = useCallback(async () => {
    const response = await fetchWithDeadline('/api/cohort/profile', { cache: 'no-store' }, CLIENT_FETCH_DEADLINE_MS);
    const body = (await response.json().catch(() => ({}))) as { profile?: Profile; error?: string };
    if (!response.ok || !body.profile) throw new Error(body.error || 'Could not load the anatomy study profile');
    setProfile(body.profile);
    return body.profile;
  }, []);
  const nextTurn = useCallback(async (size: 1) => {
    setLoading(true);
    setError(null);
    const body = pendingTurn.current ?? {
      serveRequestId: newId('anatomy-turn'),
      journeyId: journeyId.current,
      nextDrawOrdinal: ordinal.current,
      ...(previousDelivery.current ? { previousDeliveryId: previousDelivery.current } : {}),
      searchTopicId: 'module-anatomy',
    };
    pendingTurn.current = body;
    try {
      const response = await fetchWithDeadline(
        '/api/cohort/turn',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        STUDY_SESSION_FETCH_DEADLINE_MS,
      );
      const result = parseTurn(await response.json());
      if (!response.ok)
        throw new Error((result as unknown as { error?: string }).error || 'Could not build the anatomy study turn');
      if (result.sessionId !== journeyId.current || typeof result.requestedSize !== 'number')
        throw new Error('The anatomy turn returned an unexpected session');
      if (result.deliveredSize === 0) {
        if (result.requestedSize !== 1) throw new Error('The anatomy turn returned an unexpected empty turn');
        const exhaustion = parseCohortChallengeExhaustion(
          (result as unknown as { reviewChallengeExhausted?: unknown }).reviewChallengeExhausted,
        );
        if (exhaustion) {
          pendingTurn.current = null;
          automaticEase.current = authStatusRef.current === 'authenticated';
          difficultyRef.current.easeAfterExhaustion(exhaustion);
          setError('Hard questions are exhausted for now. Easing the next draw…');
          return;
        }
        pendingTurn.current = null;
        setQueue([]);
        setComplete(true);
        return;
      }
      if (result.sessionId !== journeyId.current || result.requestedSize !== size || result.deliveredSize !== size)
        throw new Error('The anatomy turn returned an unexpected number of items');
      // The delivery stays pending until its pixels are usable. A retry keeps
      // the same server delivery and the answered card remains on screen.
      const nextItem = result.items[0];
      if (isCohortCardSessionItem(nextItem) && nextItem.media) {
        await prepareAnatomyFigure(nextItem.media.target, 'prompt');
        void prepareAnatomyFigure(nextItem.media.target, 'answer').catch(() => {});
      }
      setFigureReady(!isCohortCardSessionItem(nextItem) || !nextItem.media);
      pendingTurn.current = null;
      completedDelivery.current = null;

      setQueue(result.items);
      setQueueIndex(0);
      setSelected(null);
      setRevealed(false);
      setQuestionReveal(null);
      startedAt.current = Date.now();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the next anatomy item');
    } finally {
      setLoading(false);
    }
  }, []);
  nextTurnRef.current = nextTurn;
  const startAfterProfile = useCallback(
    async () => {
      return nextTurn(1);
    },
    [nextTurn],
  );
  useEffect(() => {
    let cancelled = false;
    void loadProfile()
      .then(() => {
        if (!cancelled) return startAfterProfile();
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load the anatomy study profile');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadProfile, startAfterProfile]);

  const finishItem = async (confidence = 3) => {
    const item = queue[queueIndex];
    if (!item || advancing.current || saving || (isCohortCardSessionItem(item) && item.media && !figureReady)) return;
    advancing.current = true;
    setSaving(true);
    setError(null);
    try {
      if (completedDelivery.current !== item.deliveryId && isCohortCardSessionItem(item)) {
        const body = pendingGrade.current ?? {
          deliveryId: item.deliveryId,
          confidence,
          responseTimeMs: Math.max(0, Date.now() - startedAt.current),
          clientRequestId: newId('anatomy-grade'),
        };
        pendingGrade.current = body;
        const response = await fetchWithDeadline(
          '/api/cohort/card-grade',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
          CLIENT_FETCH_DEADLINE_MS,
        );
        if (!response.ok) throw new Error('Your card grade could not be saved');
        pendingGrade.current = null;
      }
      if (completedDelivery.current === item.deliveryId) {
        await nextTurn(1);
        return;
      }
      completedDelivery.current = item.deliveryId;
      previousDelivery.current = item.deliveryId;
      ordinal.current += 1;
      if (queueIndex + 1 < queue.length) {
        setQueueIndex((index) => index + 1);
        setSelected(null);
        setRevealed(false);
        setQuestionReveal(null);
        startedAt.current = Date.now();
      } else await nextTurn(1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your answer could not be saved');
    } finally {
      advancing.current = false;
      setSaving(false);
    }
  };
  const answerQuestion = async (confidence = 3) => {
    const item = queue[queueIndex];
    if (!item || isCohortCardSessionItem(item) || !selected || saving || questionReveal) return;
    setSaving(true);
    setError(null);
    try {
      const requestBody = pendingAnswer.current ?? {
        deliveryId: item.deliveryId,
        selectedDisplayLabel: selected,
        confidence,
        responseTimeMs: Math.max(0, Date.now() - startedAt.current),
      };
      pendingAnswer.current = requestBody;
      const response = await fetchWithDeadline(
        '/api/cohort/answer',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        },
        CLIENT_FETCH_DEADLINE_MS,
      );
      const body = (await response.json()) as { answer?: Step1AnswerReveal; error?: string };
      if (!response.ok || !body.answer) throw new Error(body.error || 'Your answer could not be confirmed');
      pendingAnswer.current = null;
      setQuestionReveal(body.answer);
      setRevealed(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your answer could not be confirmed');
    } finally {
      setSaving(false);
    }
  };

  const item = queue[queueIndex] ?? null;
  const card = isCohortCardSessionItem(item);
  const currentMediaReady = !card || !item.media || figureReady;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!item || saving || !currentMediaReady || document.querySelector('[aria-modal="true"]') || (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest('button, a, select'))) || event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === ' ' && card && !revealed && currentMediaReady) {
        event.preventDefault();
        setRevealed(true);
      } else if (/^[1-4]$/.test(event.key) && (card ? revealed : Boolean(selected)) && !questionReveal) {
        event.preventDefault();
        const level = Number(event.key);
        if (card) void finishItem(level);
        else void answerQuestion(level);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [item, saving, card, revealed, selected, questionReveal, currentMediaReady, finishItem, answerQuestion]);
  if (loading && !item && !profile)
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p role="status">Loading anatomy study…</p>
      </main>
    );
  if (error && !item && !profile)
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p role="alert">{error}</p>
        <button
          className="mt-4 underline"
          onClick={() =>
            void loadProfile()
              .then(startAfterProfile)
              .catch((cause) => setError(cause instanceof Error ? cause.message : 'Retry failed'))
          }
        >
          Retry
        </button>
      </main>
    );
  if (complete)
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-bold">Anatomy set complete</h1>
        <p className="mt-2">More reviewed anatomy content will appear as the public release grows.</p>
      </main>
    );
  if (!profile) return null;
  if (!item)
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p role="status">Preparing the next anatomy item…</p>
        {error && (
          <>
            <p role="alert" className="mt-4 text-[var(--md-error)]">
              {error}
            </p>
            <button className="mt-3 underline" onClick={() => void nextTurn(1)}>Retry</button>
          </>
        )}
      </main>
    );
  const question = card ? null : item;
  const media = card ? item.media : undefined;
  const showFigure = Boolean(media && (media.role === 'prompt' || revealed));
  const figureAlt = revealed ? media?.postAnswerAlt : media?.preAnswerAlt;
  const mediaReady = !media || figureReady;
  return (
    <main className={`mx-auto ${reviewShellWidthClass(showFigure, 'prompt-card')} px-4 pb-40 pt-3 sm:px-6 [@media(max-height:450px)]:pt-2`}>
      <header className="sticky top-0 z-10 -mx-4 mb-6 flex h-[52px] items-center justify-between gap-3 border-b border-[var(--md-outline-soft)] bg-[var(--md-surface)]/95 px-4 text-sm text-[var(--md-on-surface-variant)] shadow-[0_6px_18px_rgba(21,35,46,0.05)] backdrop-blur md:-mx-8 md:px-8">
        <Link href="/" className="underline">
          ← cohort.md
        </Link>
        <span className="truncate">Anatomy</span>
      </header>
      <div className="mb-4 flex justify-end">
        {authStatus === 'authenticated' && (
          <label className="flex items-center gap-2 text-xs text-[var(--md-on-surface-variant)]">
            <span>Difficulty</span>
            <input
              aria-label="Review difficulty"
              type="range"
              min={-2}
              max={2}
              step={1}
              value={difficulty.level}
              disabled={difficulty.pending}
              onChange={(event) => difficulty.commit(Number(event.target.value))}
            />
            <span>
              {difficulty.level === -2
                ? 'Foundations'
                : difficulty.level === 2
                  ? 'Hardest'
                  : difficulty.level === -1
                    ? 'Easier'
                    : difficulty.level === 1
                      ? 'Harder'
                      : 'Auto'}
            </span>
          </label>
        )}
      </div>
      <article className={`${showFigure ? reviewPaneGridClass('prompt-card') + ' [@media(min-width:768px)_and_(max-height:500px)]:grid [@media(min-width:768px)_and_(max-height:500px)]:grid-cols-[minmax(0,1fr)_minmax(300px,50%)] [@media(min-width:768px)_and_(max-height:500px)]:gap-x-4' : 'mx-auto max-w-2xl'}`}>
        <div className={`${showFigure ? REVIEW_PANE_TEXT_TOP + ' [@media(min-width:768px)_and_(max-height:500px)]:block [@media(min-width:768px)_and_(max-height:500px)]:col-start-1 [@media(min-width:768px)_and_(max-height:500px)]:row-start-1' : ''} min-w-0`}>
          <div data-card-stem className="mb-5 text-[var(--md-on-surface)] text-[1.03rem] leading-relaxed">
            {card ? <CardText text={item.front} answers={[item.back]} revealedCount={revealed ? 1 : 0} reserveRevealSpace={showFigure} /> : <RichText text={item.stem} />}
          </div>
          {question && (
          <div className="mt-6 grid gap-2">
            {question.options.map((option) => (
              <button
                key={option.label}
                disabled={saving || !!questionReveal || Boolean(pendingAnswer.current)}
                onClick={() => setSelected(option.label)}
                aria-pressed={selected === option.label}
                className={`rounded-lg border p-3 text-left ${selected === option.label ? 'border-[var(--md-primary)]' : 'border-[var(--md-outline-variant)]'}`}
              >
                <span className="font-medium">{option.label}.</span> <RichText text={option.text} />
              </button>
            ))}
          </div>
          )}
        {card && !revealed && (
          <div style={{ bottom: 'var(--md-review-footer-bottom, 0px)' }} className="fixed left-0 right-0 z-50 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)] p-4 shadow-[0_-10px_28px_rgba(21,35,46,0.08)] safe-area-pb md:left-20">
            <button type="button" aria-label="Show answer" disabled={!mediaReady || loading || saving} className="review-choice mx-auto block min-h-[52px] w-full max-w-2xl rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] py-3 font-medium text-[var(--md-on-surface)] transition-colors hover:bg-[var(--md-surface-container-highest)] disabled:cursor-wait disabled:opacity-60" onClick={() => setRevealed(true)}>
              {mediaReady ? <>Show answer <span className="ml-2 text-xs text-[var(--md-on-surface-variant)]">Space</span></> : 'Preparing figure…'}
            </button>
          </div>
        )}
        </div>
        {showFigure && figureAlt && <div className={REVIEW_PANE_MEDIA + ' [@media(min-width:768px)_and_(max-height:500px)]:block [@media(min-width:768px)_and_(max-height:500px)]:col-start-2 [@media(min-width:768px)_and_(max-height:500px)]:row-start-1 [@media(min-width:768px)_and_(max-height:500px)]:row-span-2'}><AnatomyReviewFigure key={item.deliveryId} target={media!.target} revealed={revealed} alt={figureAlt} onReady={setFigureReady} /></div>}
        <div className={showFigure ? REVIEW_PANE_TEXT_BOTTOM + ' [@media(min-width:768px)_and_(max-height:500px)]:block [@media(min-width:768px)_and_(max-height:500px)]:col-start-1 [@media(min-width:768px)_and_(max-height:500px)]:row-start-2' : ''}>
        {card && revealed && item.context && <div className="mt-5 border-l-2 border-[var(--md-outline-soft)] pl-3 text-sm leading-relaxed text-[var(--md-on-surface-variant)]"><RichText text={item.context} /></div>}
        {questionReveal && (
          <div className="mt-6 border-l-2 border-[var(--md-outline-soft)] pl-3">
            <p className="font-semibold">
              {questionReveal.isCorrect ? 'Correct' : `Correct answer: ${questionReveal.correctDisplayLabel}`}
            </p>
            {questionReveal.explanation && (
              <div className="mt-2 leading-relaxed">
                <RichText text={questionReveal.explanation} />
              </div>
            )}
          </div>
        )}
        {error && completedDelivery.current === item.deliveryId && (
          <button className="mt-3 underline" onClick={() => void finishItem()}>
            Retry next item
          </button>
        )}
        {questionReveal && (
          <button
            disabled={saving}
            className="mt-5 rounded-full bg-[var(--md-primary)] px-5 py-2.5 text-[var(--md-on-primary)]"
            onClick={() => void finishItem()}
          >
            Next
          </button>
        )}
        {error && (
          <p role="alert" className="mt-4 text-[var(--md-error)]">
            {error}
          </p>
        )}

        </div>

      </article>
      {revealed && !questionReveal && card && (
        <ConfidenceButtons
          mode="footer"
          onSelect={(level) => void finishItem(level)}
          status={saving || loading || !currentMediaReady ? 'saving' : 'idle'}
        />
      )}
      {!card && !questionReveal && selected && (
        <ConfidenceButtons
          mode="footer"
          onSelect={(level) => void answerQuestion(level)}
          status={saving || loading || !currentMediaReady ? 'saving' : 'idle'}
        />
      )}
    </main>
  );
}
