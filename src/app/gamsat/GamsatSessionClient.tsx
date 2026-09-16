'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  CLIENT_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';
import {
  applyAnswer,
  loadMastery,
  loadRecentPassages,
  masteryReport,
  pushRecentPassage,
  saveMastery,
} from '@/lib/gamsat/mastery';
import { selectPassage, type PassageSummary } from '@/lib/gamsat/select';
import type { GamsatMove, GamsatPassage, MasteryState } from '@/lib/gamsat/types';

interface PassagePayload {
  passage: GamsatPassage;
  moves: GamsatMove[];
}

type Phase = 'loading' | 'error' | 'ready' | 'done';

export default function GamsatSessionClient() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [summaries, setSummaries] = useState<PassageSummary[]>([]);
  const [payload, setPayload] = useState<PassagePayload | null>(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [mastery, setMastery] = useState<MasteryState>({});
  const [correctCount, setCorrectCount] = useState(0);
  const [showProgress, setShowProgress] = useState(false);

  const question = payload?.passage.questions[index] ?? null;
  const questionStartedAt = useRef<number>(Date.now());
  const movesById = useMemo(
    () => new Map((payload?.moves ?? []).map((m) => [m.id, m])),
    [payload],
  );

  const loadPassage = useCallback(async (index: PassageSummary[]) => {
    const state = loadMastery();
    setMastery(state);
    const recent = loadRecentPassages();
    const seenDomains = index
      .filter((summary) => recent.includes(summary.id))
      .map((summary) => summary.domain);

    const picked = selectPassage(index, state, recent, { seenDomains });
    if (!picked) {
      setPhase('error');
      return;
    }

    // Deadline-guarded: an unguarded await can hang forever and strand the
    // session on its loading state.
    const response = await fetchWithDeadline(
      `/api/gamsat/passage/${encodeURIComponent(picked.id)}`,
      { cache: 'no-store' },
      CLIENT_FETCH_DEADLINE_MS,
    );
    if (!response.ok) throw new Error('passage fetch failed');
    setPayload((await response.json()) as PassagePayload);
    pushRecentPassage(picked.id, recent);
    setIndex(0);
    setSelected(null);
    setRevealed(false);
    setCorrectCount(0);
    setPhase('ready');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithDeadline(
          '/api/gamsat/corpus',
          { cache: 'no-store', signal: controller.signal },
          CLIENT_FETCH_DEADLINE_MS,
        );
        if (!response.ok) throw new Error('corpus fetch failed');
        const data = (await response.json()) as { passages: PassageSummary[] };
        if (cancelled) return;
        setSummaries(data.passages);
        await loadPassage(data.passages);
      } catch {
        if (!cancelled) setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [loadPassage]);

  const reveal = useCallback(() => {
    if (!question || selected === null || revealed) return;
    const isCorrect = question.options.find((o) => o.label === selected)?.isCorrect ?? false;

    // Local state first: the reveal must never wait on the network, and a
    // failed write must not cost the learner their session.
    const next = applyAnswer(loadMastery(), question.moves, isCorrect);
    saveMastery(next);
    setMastery(next);
    if (isCorrect) setCorrectCount((n) => n + 1);
    setRevealed(true);

    // Then record it. The server re-grades from the stored question, so this
    // is a report of what happened, not a claim about correctness.
    void fetchWithDeadline('/api/gamsat/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questionId: question.id,
        selectedLabel: selected,
        displayOrder: question.options.map((o) => o.label),
        responseTimeMs: Date.now() - questionStartedAt.current,
      }),
    }, CLIENT_FETCH_DEADLINE_MS).catch(() => {
      // Recording is best-effort: losing one response is bad, but blocking a
      // study session on a write is worse.
    });
  }, [question, selected, revealed]);

  const advance = useCallback(() => {
    if (!payload) return;
    if (index + 1 >= payload.passage.questions.length) {
      setPhase('done');
      return;
    }
    setIndex((i) => i + 1);
    setSelected(null);
    setRevealed(false);
  }, [payload, index]);

  useEffect(() => {
    questionStartedAt.current = Date.now();
  }, [question?.id]);

  // Keyboard: 1-5 select, Enter reveals then advances. Matches the review surface.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (phase !== 'ready' || !question) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (/^[1-9]$/.test(event.key) && !revealed) {
        const option = question.options[Number(event.key) - 1];
        if (option) setSelected(option.label);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (revealed) advance();
        else reveal();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, question, revealed, reveal, advance]);

  if (phase === 'loading') {
    return <Shell><p className="text-[var(--md-on-surface-variant)]">Loading…</p></Shell>;
  }

  if (phase === 'error') {
    return (
      <Shell>
        <p className="text-[var(--md-error)]">Could not load the corpus.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 rounded-full bg-[var(--md-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--md-on-primary)]"
        >
          Try again
        </button>
      </Shell>
    );
  }

  if (phase === 'done' || !payload || !question) {
    const rows = masteryReport(mastery).slice(0, 8);
    return (
      <Shell>
        <h2 className="text-2xl font-bold text-[var(--md-on-surface)]">
          {correctCount} / {payload?.passage.questions.length ?? 0}
        </h2>
        <p className="mt-2 text-[var(--md-on-surface-variant)]">
          {payload?.passage.title}
        </p>

        {rows.length > 0 && (
          <div className="mt-8">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--md-on-surface-variant)]">
              Your reasoning moves, weakest first
            </h3>
            <ul className="mt-3 space-y-2">
              {rows.map((row) => (
                <li key={row.moveId} className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="text-[var(--md-on-surface)]">{row.moveId}</span>
                  <span className="tabular-nums text-[var(--md-on-surface-variant)]">
                    {Math.round(row.accuracy * 100)}% · {row.attempts}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            setPhase('loading');
            void loadPassage(summaries).catch(() => setPhase('error'));
          }}
          className="mt-8 block rounded-full bg-[var(--md-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--md-on-primary)]"
        >
          Next passage
        </button>
        </Shell>
    );
  }

  const total = payload.passage.questions.length;

  return (
    <Shell>
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--md-on-surface-variant)]">
          {payload.passage.section === 's1' ? 'Section I' : 'Section III'} · {payload.passage.title}
        </p>
        <p className="text-xs tabular-nums text-[var(--md-on-surface-variant)]">
          {index + 1} / {total}
        </p>
      </div>

      <PassageBody markdown={payload.passage.passage} />

      <hr className="my-8 border-[var(--md-outline-variant)]" />

      <h2 className="text-lg font-semibold text-[var(--md-on-surface)]">{question.stem}</h2>

      <ul className="mt-5 space-y-2">
        {question.options.map((option, i) => {
          const isSelected = selected === option.label;
          const showCorrect = revealed && option.isCorrect;
          const showWrong = revealed && isSelected && !option.isCorrect;
          return (
            <li key={option.label}>
              <button
                type="button"
                disabled={revealed}
                onClick={() => setSelected(option.label)}
                className={[
                  'flex w-full items-baseline gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors',
                  showCorrect
                    ? 'border-[var(--md-success)] bg-[var(--md-success-container)]'
                    : showWrong
                      ? 'border-[var(--md-error)] bg-[var(--md-error-container)]'
                      : isSelected
                        ? 'border-[var(--md-primary)] bg-[var(--md-surface-container-high)]'
                        : 'border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]',
                ].join(' ')}
              >
                <span className="shrink-0 tabular-nums text-[var(--md-on-surface-variant)]">
                  {i + 1}
                </span>
                <span className="text-[var(--md-on-surface)]">{option.text}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {!revealed && (
        <button
          type="button"
          disabled={selected === null}
          onClick={reveal}
          className="mt-6 block rounded-full bg-[var(--md-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--md-on-primary)] disabled:opacity-40"
        >
          Check
        </button>
      )}

      {revealed && (
        <div className="mt-6">
          {/* The move reveal is the product: not just whether you were right, but
              which reasoning move the question was testing. */}
          <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--md-on-surface-variant)]">
              Reasoning {question.moves.length > 1 ? 'moves' : 'move'} tested
            </p>
            <ul className="mt-2 space-y-2">
              {question.moves.map((moveId) => {
                const move = movesById.get(moveId);
                return (
                  <li key={moveId}>
                    <p className="text-sm font-semibold text-[var(--md-on-surface)]">
                      {move?.name ?? moveId}
                    </p>
                    {move && (
                      <p className="mt-0.5 text-sm text-[var(--md-on-surface-variant)]">
                        {move.definition}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
            {question.explanation}
          </p>

          <button
            type="button"
            onClick={advance}
            className="mt-6 block rounded-full bg-[var(--md-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--md-on-primary)]"
          >
            {index + 1 >= total ? 'Finish' : 'Next'}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowProgress((v) => !v)}
        className="mt-10 block text-xs font-semibold text-[var(--md-primary)] underline underline-offset-2"
      >
        {showProgress ? 'Hide' : 'Show'} your reasoning-move profile
      </button>
      {showProgress && (
        <ul className="mt-3 space-y-1.5">
          {masteryReport(mastery).map((row) => (
            <li key={row.moveId} className="flex items-baseline justify-between gap-4 text-xs">
              <span className="text-[var(--md-on-surface)]">{row.moveId}</span>
              <span className="tabular-nums text-[var(--md-on-surface-variant)]">
                {Math.round(row.accuracy * 100)}% · {row.attempts}
              </span>
            </li>
          ))}
          {masteryReport(mastery).length === 0 && (
            <li className="text-xs text-[var(--md-on-surface-variant)]">
              Answer a question to start building your profile.
            </li>
          )}
        </ul>
      )}

    </Shell>
  );
}

/**
 * The stimulus. Styled explicitly rather than via `prose` — this project has no
 * Tailwind typography plugin, so those classes are inert, and the Section III
 * passages carry data tables that must stay readable and horizontally
 * scrollable on a phone rather than overflowing the page.
 */
function PassageBody({ markdown }: { markdown: string }) {
  return (
    <article className="mt-4 text-[15px] leading-relaxed text-[var(--md-on-surface)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-4">{children}</p>,
          h1: ({ children }) => (
            <h2 className="mb-3 mt-6 text-lg font-bold">{children}</h2>
          ),
          h2: ({ children }) => (
            <h3 className="mb-2 mt-5 text-base font-semibold">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="mb-2 mt-4 text-sm font-semibold uppercase tracking-wide">{children}</h4>
          ),
          ul: ({ children }) => <ul className="mb-4 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1 pl-5">{children}</ol>,
          em: ({ children }) => <em className="italic">{children}</em>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className="mb-4 border-l-2 border-[var(--md-outline-variant)] pl-4 italic">
              {children}
            </blockquote>
          ),
          // Wide tables scroll inside their own container; the page never does.
          table: ({ children }) => (
            <div className="mb-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm tabular-nums">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-3 py-1.5 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[var(--md-outline-variant)] px-3 py-1.5">{children}</td>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">{children}</main>;
}

