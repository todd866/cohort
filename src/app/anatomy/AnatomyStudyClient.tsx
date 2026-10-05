'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import { useReviewDifficulty } from '@/hooks/useReviewDifficulty';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { InlineMarkdown } from '@/lib/inline-markdown';
import { genClientRequestId } from '@/lib/client-request-id';
import { extractMarkdownTables, MarkdownTable } from '@/lib/inline-markdown';
import {
  fetchWithDeadline,
  CLIENT_FETCH_DEADLINE_MS,
  STUDY_SESSION_FETCH_DEADLINE_MS,
} from '@/lib/fetch-with-deadline';
import { COHORT_EXPERIENCE_OPTIONS, type CohortExperience } from '@/lib/cohort/experience-prior';
import {
  isCohortCardSessionItem,
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
function renderFront(front: string) {
  const [before, after] = front.split('[___]');
  return (
    <>
      <InlineMarkdown text={before} />
      <span className="mx-1 inline-block min-w-20 border-b-2 border-current align-baseline" />
      {after ? <InlineMarkdown text={after} /> : null}
    </>
  );
}
function isItem(value: unknown): value is Item {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (item.kind === 'card') return isCohortCardSessionItem(item);
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
    (result.deliveredSize !== 0 && result.deliveredSize !== 1 && result.deliveredSize !== 3) ||
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
  const [experienceSaving, setExperienceSaving] = useState(false);
  const [hookPending, setHookPending] = useState(false);
  const [hookError, setHookError] = useState(false);
  const journeyId = useRef(newId('anatomy-journey'));
  const ordinal = useRef(0);
  const previousDelivery = useRef<string | null>(null);
  const pendingTurn = useRef<Record<string, unknown> | null>(null);
  const pendingGrade = useRef<Record<string, unknown> | null>(null);
  const pendingHook = useRef<Record<string, unknown> | null>(null);
  const pendingAnswer = useRef<Record<string, unknown> | null>(null);
  const completedDelivery = useRef<string | null>(null);
  const advancing = useRef(false);
  const startedAt = useRef(Date.now());
  const intro = useRef(false);
  const automaticEase = useRef(false);
  const nextTurnRef = useRef<(size: 1 | 3) => Promise<void>>(async () => {});
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
  const nextTurn = useCallback(async (size: 1 | 3) => {
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
      pendingTurn.current = null;
      completedDelivery.current = null;
      intro.current = size === 3;
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
    async (loaded: Profile) => {
      if (!loaded.hookCompletedAt) return nextTurn(3);
      if (!loaded.explicit.experience) return;
      return nextTurn(1);
    },
    [nextTurn],
  );
  useEffect(() => {
    let cancelled = false;
    void loadProfile()
      .then((loaded) => {
        if (!cancelled) return startAfterProfile(loaded);
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

  const saveExperience = async (experience: CohortExperience) => {
    setExperienceSaving(true);
    setError(null);
    try {
      const response = await fetchWithDeadline(
        '/api/cohort/profile',
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experience }) },
        CLIENT_FETCH_DEADLINE_MS,
      );
      const body = (await response.json().catch(() => ({}))) as { profile?: Profile; error?: string };
      if (!response.ok || !body.profile) throw new Error(body.error || 'Could not save your study level');
      const refreshed = await loadProfile();
      if (refreshed.explicit.experience) await nextTurn(1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your study level');
    } finally {
      setExperienceSaving(false);
    }
  };
  const completeHook = async () => {
    const body = pendingHook.current ?? { hookCompleted: true };
    pendingHook.current = body;
    setHookPending(true);
    setHookError(false);
    setError(null);
    try {
      const response = await fetchWithDeadline(
        '/api/cohort/profile',
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        CLIENT_FETCH_DEADLINE_MS,
      );
      const payload = (await response.json().catch(() => ({}))) as { profile?: Profile; error?: string };
      if (!response.ok || !payload.profile) throw new Error(payload.error || 'Could not save your introduction');
      pendingHook.current = null;
      const refreshed = await loadProfile();
      setQueue([]);
      setQueueIndex(0);
      intro.current = false;
      if (!refreshed.explicit.experience) return;
      await nextTurn(1);
    } catch (cause) {
      setHookError(true);
      setError(cause instanceof Error ? cause.message : 'Could not save your introduction');
    } finally {
      setHookPending(false);
    }
  };

  const finishItem = async (confidence = 3) => {
    const item = queue[queueIndex];
    if (!item || advancing.current || saving) return;
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
        if (intro.current) await completeHook();
        else await nextTurn(1);
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
      } else if (intro.current) await completeHook();
      else await nextTurn(1);
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
  if (profile.hookCompletedAt && !profile.explicit.experience && !item)
    return (
      <main className="mx-auto max-w-2xl px-4 py-6 pb-24">
        <header className="mb-6 flex items-center justify-between text-sm text-[var(--md-on-surface-variant)]">
          <Link href="/" className="underline">
            ← cohort.md
          </Link>
          <span>Anatomy</span>
        </header>
        <section
          role="dialog"
          aria-label="Choose study level"
          className="rounded-xl border border-[var(--md-outline-variant)] p-4"
        >
          <h1 className="text-xl font-semibold">Where are you in your anatomy study?</h1>
          <div className="mt-3 grid gap-2">
            {COHORT_EXPERIENCE_OPTIONS.map((option) => (
              <button
                key={option.id}
                disabled={experienceSaving}
                onClick={() => void saveExperience(option.id)}
                className="rounded-lg border px-3 py-2 text-left text-sm"
              >
                {option.label}
              </button>
            ))}
          </div>
          {error && (
            <p role="alert" className="mt-4 text-[var(--md-error)]">
              {error}
            </p>
          )}
        </section>
      </main>
    );
  if (!item)
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p role="status">Preparing the next anatomy item…</p>
        {error && (
          <>
            <p role="alert" className="mt-4 text-[var(--md-error)]">
              {error}
            </p>
            {profile.hookCompletedAt ? (
              <button className="mt-3 underline" onClick={() => void nextTurn(1)}>
                Retry
              </button>
            ) : (
              <button className="mt-3 underline" onClick={() => void nextTurn(3)}>
                Retry introduction
              </button>
            )}
          </>
        )}
      </main>
    );
  const card = isCohortCardSessionItem(item);
  const question = card ? null : item;
  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-32 sm:py-10 [@media(max-height:450px)]:pt-2">
      <header className="mb-4 [@media(max-height:450px)]:mb-1 flex items-center justify-between text-sm text-[var(--md-on-surface-variant)]">
        <Link href="/" className="underline">
          ← cohort.md
        </Link>
        <Link href="/anatomy/abducens" className="underline">
          Eye movement guide
        </Link>
        <span>Anatomy</span>
      </header>
      <div className="relative mb-4 flex justify-end">
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
      <article className="rounded-2xl border border-[var(--md-outline-variant)] p-5 shadow-sm [@media(max-height:450px)]:p-3">
        <p className="text-xs uppercase tracking-wide text-[var(--md-on-surface-variant)]">{item.domain}</p>
        <div data-card-stem className="mt-4 text-xl leading-relaxed [@media(max-height:450px)]:mt-2">
          {card ? renderFront(item.front) : <RichText text={item.stem} />}
        </div>
        {question && (
          <div className="mt-5 grid gap-2">
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
          <button
            className="mt-6 rounded-full bg-[var(--md-primary)] px-5 py-2.5 text-[var(--md-on-primary)]"
            onClick={() => setRevealed(true)}
          >
            Show answer
          </button>
        )}
        {card && revealed && (
          <div className="mt-5 rounded-xl bg-[var(--md-surface-container)] p-4">
            <div className="font-semibold">
              <RichText text={item.back} />
            </div>
            {item.context && (
              <div className="mt-2 leading-relaxed">
                <RichText text={item.context} />
              </div>
            )}
          </div>
        )}
        {questionReveal && (
          <div className="mt-5 rounded-xl border p-4">
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
        {error && completedDelivery.current === item.deliveryId && !hookPending && (
          <button className="mt-3 underline" onClick={() => void finishItem()}>
            Retry next item
          </button>
        )}
        {questionReveal && (
          <button
            disabled={saving || hookPending}
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
        {hookError && (
          <button className="mt-3 underline" onClick={() => void completeHook()}>
            Retry introduction
          </button>
        )}
      </article>
      {revealed && !questionReveal && card && completedDelivery.current !== item.deliveryId && (
        <ConfidenceButtons
          mode="footer"
          onSelect={(level) => void finishItem(level)}
          status={saving ? 'saving' : 'idle'}
        />
      )}
      {!card && !questionReveal && selected && (
        <ConfidenceButtons
          mode="footer"
          onSelect={(level) => void answerQuestion(level)}
          status={saving ? 'saving' : 'idle'}
        />
      )}
    </main>
  );
}
