'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExamScenario, ScenarioNode } from '@/lib/clinical-exams';

/**
 * Mild choose-your-own-adventure trainer over a clinical drill — born from the
 * same failed paediatric BLS WBA as the drill layer. One slide per decision
 * node: pick the correct choice → its feedback shows → Continue advances (or
 * follows the choice's `goto`). Pick a wrong choice → its consequence shows,
 * that choice is spent, and the same node re-offers what remains until the
 * correct move is found. The finish slide tallies FIRST-TRY correctness only —
 * an assessor gives no second attempts, so re-run until it reads 100%.
 *
 * Choice order is shuffled per run (assessors vary order too) via an
 * injectable `shuffle` so tests stay deterministic. Dependency-free client JS;
 * design tokens only.
 */

/** Fisher–Yates over [0..count), driven by an injectable rng. Pure given rng. */
export function shuffledIndices(
  count: number,
  rng: () => number,
): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const defaultShuffle = (count: number) => shuffledIndices(count, Math.random);

type Phase = 'idle' | 'running' | 'finished';

interface RunState {
  phase: Phase;
  /** Index into scenario.nodes of the current slide. */
  nodeIndex: number;
  /** Per-run choice display order, one index array per node. */
  orders: number[][];
  /** Choice indices already picked on the CURRENT node, in pick order. */
  picked: number[];
  /** Nodes cleared so far this run. */
  cleared: number;
  /** Nodes cleared on the first pick. */
  firstTry: number;
}

const idleState: RunState = {
  phase: 'idle',
  nodeIndex: 0,
  orders: [],
  picked: [],
  cleared: 0,
  firstTry: 0,
};

function freshRun(
  scenario: ExamScenario,
  shuffle: (count: number) => number[],
): RunState {
  return {
    phase: 'running',
    nodeIndex: 0,
    orders: scenario.nodes.map((node) => shuffle(node.choices.length)),
    picked: [],
    cleared: 0,
    firstTry: 0,
  };
}

function nextNodeIndex(scenario: ExamScenario, node: ScenarioNode): number {
  const correct = node.choices.find((c) => c.correct);
  if (correct?.goto) {
    const target = scenario.nodes.findIndex((n) => n.id === correct.goto);
    if (target >= 0) return target;
  }
  return scenario.nodes.indexOf(node) + 1;
}

export function ScenarioTrainer({
  scenario,
  shuffle = defaultShuffle,
}: {
  scenario?: ExamScenario;
  /** Injectable per-node choice order — tests pass a deterministic order. */
  shuffle?: (count: number) => number[];
}) {
  const [run, setRun] = useState<RunState>(idleState);

  const node = scenario?.nodes[run.nodeIndex];
  const solved =
    node !== undefined &&
    run.picked.some((i) => node.choices[i]?.correct === true);

  const begin = useCallback(() => {
    if (scenario) setRun(freshRun(scenario, shuffle));
  }, [scenario, shuffle]);

  const pick = useCallback(
    (choiceIndex: number) => {
      setRun((prev) => {
        const current = scenario?.nodes[prev.nodeIndex];
        if (!scenario || !current || prev.phase !== 'running') return prev;
        const alreadySolved = prev.picked.some(
          (i) => current.choices[i]?.correct === true,
        );
        if (alreadySolved || prev.picked.includes(choiceIndex)) return prev;
        if (!current.choices[choiceIndex]) return prev;
        return { ...prev, picked: [...prev.picked, choiceIndex] };
      });
    },
    [scenario],
  );

  const advance = useCallback(() => {
    setRun((prev) => {
      const current = scenario?.nodes[prev.nodeIndex];
      if (!scenario || !current || prev.phase !== 'running') return prev;
      const isSolved = prev.picked.some(
        (i) => current.choices[i]?.correct === true,
      );
      if (!isSolved) return prev;
      const cleared = prev.cleared + 1;
      const firstTry = prev.firstTry + (prev.picked.length === 1 ? 1 : 0);
      const next = nextNodeIndex(scenario, current);
      if (next >= scenario.nodes.length) {
        return { ...prev, phase: 'finished', cleared, firstTry, picked: [] };
      }
      return { ...prev, nodeIndex: next, cleared, firstTry, picked: [] };
    });
  }, [scenario]);

  // Displayed order for the current node — stable within the node for the run.
  const displayOrder = useMemo(() => {
    if (!node) return [];
    return (
      run.orders[run.nodeIndex] ??
      Array.from({ length: node.choices.length }, (_, i) => i)
    );
  }, [node, run.orders, run.nodeIndex]);

  // Keyboard: number keys pick the visible choice, Enter continues.
  useEffect(() => {
    if (run.phase !== 'running') return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === 'Enter') {
        if (solved) {
          event.preventDefault();
          advance();
        }
        return;
      }
      const n = Number.parseInt(event.key, 10);
      if (Number.isInteger(n) && n >= 1 && n <= displayOrder.length) {
        event.preventDefault();
        pick(displayOrder[n - 1]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [run.phase, solved, displayOrder, pick, advance]);

  if (!scenario || scenario.nodes.length === 0) return null;

  const total = scenario.nodes.length;

  return (
    <section aria-label="Scenario trainer" className="mt-10">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-[0.7rem] font-bold uppercase tracking-[0.14em] text-[var(--md-on-surface-variant)] whitespace-nowrap">
          Scenario
        </h2>
        <span className="h-px flex-1 bg-[var(--md-outline-soft)]" aria-hidden />
      </div>

      {run.phase === 'idle' && (
        <div className="rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-4">
          <p className="text-[1.05rem] font-bold tracking-tight text-[var(--md-on-surface)]">
            {scenario.title}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
            {scenario.intro}
          </p>
          <button
            type="button"
            onClick={begin}
            className="mt-4 min-h-11 w-full rounded-lg bg-[var(--md-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--md-on-primary)] transition-opacity hover:opacity-90 sm:w-auto"
          >
            Run the scenario
          </button>
        </div>
      )}

      {run.phase === 'running' && node && (
        <div className="rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-4">
          <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
            Decision {run.cleared + 1} of {total}
          </p>
          <p className="mt-2 text-[1.02rem] leading-snug font-bold tracking-tight text-[var(--md-on-surface)]">
            {node.prompt}
          </p>

          <div className="mt-3 space-y-2" aria-live="polite">
            {displayOrder.map((choiceIndex, displayIndex) => {
              const choice = node.choices[choiceIndex];
              if (!choice) return null;
              const isPicked = run.picked.includes(choiceIndex);
              const outcomeClass = choice.correct
                ? 'border-[var(--md-success)]'
                : 'border-[var(--md-error)]';
              const feedbackTextClass = choice.correct
                ? 'text-[var(--md-success)]'
                : 'text-[var(--md-error)]';
              return (
                <div
                  key={choice.text}
                  className={
                    isPicked
                      ? `rounded-lg border-l-[3px] ${outcomeClass}`
                      : undefined
                  }
                >
                  <button
                    type="button"
                    disabled={isPicked || solved}
                    onClick={() => pick(choiceIndex)}
                    className={`min-h-11 w-full rounded-lg border px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                      isPicked
                        ? 'border-transparent text-[var(--md-on-surface-variant)]'
                        : 'border-[var(--md-outline-soft)] text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)] disabled:opacity-60'
                    }`}
                  >
                    <span
                      className="mr-2 text-xs font-bold tabular-nums text-[var(--md-on-surface-variant)]"
                      aria-hidden
                    >
                      {displayIndex + 1}
                    </span>
                    {choice.text}
                  </button>
                  {isPicked && (
                    <p
                      className={`px-3 pb-2 pt-1 text-sm leading-relaxed ${feedbackTextClass}`}
                    >
                      {choice.feedback}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {solved && (
            <button
              type="button"
              onClick={advance}
              className="mt-4 min-h-11 w-full rounded-lg bg-[var(--md-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--md-on-primary)] transition-opacity hover:opacity-90 sm:w-auto"
            >
              Continue
            </button>
          )}
          <p className="mt-3 text-[0.7rem] text-[var(--md-on-surface-variant)]">
            Keys: 1-{displayOrder.length} choose · Enter continues
          </p>
        </div>
      )}

      {run.phase === 'finished' && (
        <div className="rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-4">
          <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
            Scenario complete
          </p>
          <p className="mt-2 text-[1.05rem] font-bold tracking-tight text-[var(--md-on-surface)]">
            {run.firstTry} of {run.cleared} decisions right first time
          </p>
          {run.firstTry < run.cleared ? (
            <p className="mt-1 text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
              An assessor gives no retries — re-run until every decision is
              right first time.
            </p>
          ) : (
            <p className="mt-1 text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
              Clean run. Come back cold tomorrow and hold it.
            </p>
          )}
          <button
            type="button"
            onClick={begin}
            className="mt-4 min-h-11 w-full rounded-lg bg-[var(--md-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--md-on-primary)] transition-opacity hover:opacity-90 sm:w-auto"
          >
            Run again
          </button>
        </div>
      )}
    </section>
  );
}
